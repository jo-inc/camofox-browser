import {
  normalizeRequestProxy,
  redactProxy,
  requestProxiesEqual,
  resolveRequestProxy,
} from '../../lib/request-proxy.js';

describe('normalizeRequestProxy', () => {
  test('accepts a narrow Playwright proxy object', () => {
    expect(normalizeRequestProxy({
      server: ' http://gw.example.com:10000 ',
      username: 'user',
      password: 'pass',
    })).toEqual({
      server: 'http://gw.example.com:10000',
      username: 'user',
      password: 'pass',
    });
  });

  test('rejects embedded credentials to avoid accidental leakage', () => {
    expect(() => normalizeRequestProxy({
      server: 'http://user:pass@gw.example.com:10000',
    })).toThrow('proxy credentials must be provided');
  });

  test('rejects unsupported schemes', () => {
    expect(() => normalizeRequestProxy({ server: 'ftp://gw.example.com:21' })).toThrow('proxy.server scheme');
  });

  test('length-limits credentials', () => {
    expect(() => normalizeRequestProxy({
      server: 'http://gw.example.com:10000',
      username: 'u'.repeat(513),
    })).toThrow('proxy.username is too long');
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

  test('allows existing session when same proxy is supplied', () => {
    expect(resolveRequestProxy({
      requestedProxy: proxyA,
      existingSession: { requestProxy: proxyA },
      globalProxyActive: false,
    })).toEqual(proxyA);
  });

  test('rejects changing proxy on an existing session', () => {
    expect(() => resolveRequestProxy({
      requestedProxy: proxyB,
      existingSession: { requestProxy: proxyA },
      globalProxyActive: false,
    })).toThrow('existing session uses a different proxy');
  });

  test('rejects request proxy when a global proxy pool is active', () => {
    expect(() => resolveRequestProxy({
      requestedProxy: proxyA,
      existingSession: null,
      globalProxyActive: true,
    })).toThrow('global proxy configuration is active');
  });

  test('treats omitted proxy as no-op', () => {
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
