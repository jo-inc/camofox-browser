import {
  assertRequestProxyCompatible,
  createRequestProxyRecoveryCache,
  normalizeRequestProxy,
  redactProxy,
  REQUEST_PROXY_RECOVERY_REASONS,
  requestProxiesEqual,
  resolveRequestProxy,
  shouldPreserveRequestProxy,
} from '../../lib/request-proxy.js';

describe('normalizeRequestProxy', () => {
  test.each(['http', 'https', 'socks4', 'socks5'])('accepts the %s scheme', scheme => {
    expect(normalizeRequestProxy({ server: ` ${scheme}://gw.example.com:10000 ` })).toEqual({
      server: `${scheme}://gw.example.com:10000`,
    });
  });

  test('accepts optional Playwright credentials', () => {
    expect(normalizeRequestProxy({
      server: 'http://gw.example.com:10000',
      username: 'user',
      password: 'pass',
    })).toEqual({
      server: 'http://gw.example.com:10000',
      username: 'user',
      password: 'pass',
    });
  });

  test('preserves valid percent sequences in literal request credentials', () => {
    const proxy = {
      server: 'http://gw.example.com:10000',
      username: 'request%user',
      password: 'p%2Fssword',
    };
    expect(normalizeRequestProxy(proxy)).toEqual(proxy);
  });

  test('rejects null instead of treating it as omission', () => {
    expect(() => normalizeRequestProxy(null)).toThrow('proxy must be an object');
  });

  test('rejects embedded credentials to avoid accidental leakage', () => {
    expect(() => normalizeRequestProxy({
      server: 'http://user:pass@gw.example.com:10000',
    })).toThrow('proxy credentials must be provided');
  });

  test('rejects unsupported schemes and missing hosts', () => {
    expect(() => normalizeRequestProxy({ server: 'ftp://gw.example.com:21' })).toThrow('proxy.server scheme');
    expect(() => normalizeRequestProxy({ server: 'http://' })).toThrow('proxy.server');
  });

  test('type- and length-limits credentials', () => {
    expect(() => normalizeRequestProxy({
      server: 'http://gw.example.com:10000',
      username: 123,
    })).toThrow('proxy.username must be a string');
    expect(() => normalizeRequestProxy({
      server: 'http://gw.example.com:10000',
      username: 'u'.repeat(513),
    })).toThrow('proxy.username is too long');
  });

  test('rejects fields the OpenAPI schema does not support', () => {
    expect(() => normalizeRequestProxy({
      server: 'http://gw.example.com:10000',
      bypass: '*.internal',
    })).toThrow('proxy contains unsupported fields');
  });
});

describe('request proxy session semantics', () => {
  const proxyA = { server: 'http://gw.example.com:10000', username: 'u1', password: 'p1' };
  const proxyB = { server: 'http://gw.example.com:10001', username: 'u1', password: 'p1' };

  test('accepts proxy on first session creation', () => {
    expect(resolveRequestProxy({
      requestedProxy: proxyA,
      existingSession: null,
      globalProxyActive: false,
    })).toEqual(proxyA);
  });

  test('allows existing session when the identical proxy is supplied', () => {
    expect(resolveRequestProxy({
      requestedProxy: proxyA,
      existingSession: { requestProxy: proxyA },
      globalProxyActive: false,
    })).toEqual(proxyA);
  });

  test('rejects changing proxy on an existing session with actionable metadata', () => {
    expect.assertions(4);
    try {
      resolveRequestProxy({
        requestedProxy: proxyB,
        existingSession: { requestProxy: proxyA },
        globalProxyActive: false,
      });
    } catch (err) {
      expect(err.statusCode).toBe(409);
      expect(err.code).toBe('proxy_conflict');
      expect(err.recovery).toBe('delete_session');
      expect(err.retryable).toBe(false);
    }
  });

  test('rejects request proxy when a global proxy pool is active', () => {
    expect.assertions(4);
    try {
      resolveRequestProxy({
        requestedProxy: proxyA,
        existingSession: null,
        globalProxyActive: true,
      });
    } catch (err) {
      expect(err.statusCode).toBe(409);
      expect(err.code).toBe('proxy_mode_conflict');
      expect(err.recovery).toBe('remove_request_proxy');
      expect(err.retryable).toBe(false);
    }
  });

  test('treats an omitted proxy as a no-op', () => {
    expect(resolveRequestProxy({
      requestedProxy: undefined,
      existingSession: { requestProxy: proxyA },
      globalProxyActive: false,
    })).toBeNull();
  });

  test('compares full proxy config including credentials', () => {
    expect(requestProxiesEqual(proxyA, { ...proxyA })).toBe(true);
    expect(requestProxiesEqual(proxyA, { ...proxyA, password: 'different' })).toBe(false);
  });

  test('fails closed when a live or coalesced session has a different proxy', () => {
    expect(assertRequestProxyCompatible(proxyA, { ...proxyA })).toEqual(proxyA);
    expect(() => assertRequestProxyCompatible(proxyA, proxyB)).toThrow('different proxy');
  });
});

describe('request proxy recovery cache', () => {
  test.each([
    'route_dead_context',
    'dead_context',
    'browser_disconnected',
    'browser_restart:health_check',
    'navigation_timeout',
    'new_page_unresponsive',
    'pressure_cleanup_empty_session',
    'session_timeout',
    'memory_pressure',
    'tab_reaper_empty_session',
  ])('preserves request proxy for automatic teardown reason %s', reason => {
    expect(shouldPreserveRequestProxy(reason)).toBe(true);
  });

  test.each([
    'api_delete_session',
    'admin_stop',
    'destroy_session',
    'session_closed',
    'storage_reset',
    'shutdown:SIGTERM',
  ])('clears request proxy for intentional teardown reason %s', reason => {
    expect(shouldPreserveRequestProxy(reason)).toBe(false);
  });

  test('exports the complete automatic recovery inventory', () => {
    expect(REQUEST_PROXY_RECOVERY_REASONS).toEqual([
      'route_dead_context',
      'dead_context',
      'browser_disconnected',
      'navigation_timeout',
      'new_page_unresponsive',
      'pressure_cleanup_empty_session',
      'session_timeout',
      'memory_pressure',
      'tab_reaper_empty_session',
    ]);
  });

  const proxy = { server: 'http://gw.example.com:10000', username: 'u', password: 'p' };

  test('retains normalized proxy until successful recreation clears it', () => {
    let now = 1_000;
    const cache = createRequestProxyRecoveryCache({ ttlMs: 300_000, maxEntries: 2, now: () => now });

    cache.remember('user-1', proxy);
    expect(cache.get('user-1')).toEqual(proxy);
    expect(cache.get('user-1')).toEqual(proxy);
    cache.delete('user-1');
    expect(cache.get('user-1')).toBeNull();
  });

  test('expires entries and evicts the oldest entry when bounded', () => {
    let now = 1_000;
    const cache = createRequestProxyRecoveryCache({ ttlMs: 100, maxEntries: 2, now: () => now });

    cache.remember('user-1', proxy);
    now += 1;
    cache.remember('user-2', { ...proxy, server: 'http://gw.example.com:10001' });
    now += 1;
    cache.remember('user-3', { ...proxy, server: 'http://gw.example.com:10002' });
    expect(cache.get('user-1')).toBeNull();
    expect(cache.size).toBe(2);

    now = 1_101;
    expect(cache.get('user-2')).toBeNull();
    expect(cache.size).toBe(1);
  });

  test('copies values so callers cannot mutate cached credentials', () => {
    const cache = createRequestProxyRecoveryCache();
    const mutable = { ...proxy };
    cache.remember('user-1', mutable);
    mutable.password = 'changed';

    expect(cache.get('user-1')).toEqual(proxy);
  });
});

describe('redactProxy', () => {
  test('does not expose credentials', () => {
    expect(redactProxy({
      server: 'http://gw.example.com:10000',
      username: 'secret-user',
      password: 'secret-pass',
    })).toEqual({
      server: 'http://gw.example.com:10000',
      username: '<redacted>',
      password: '<redacted>',
    });
  });
});
