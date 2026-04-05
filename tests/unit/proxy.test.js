import {
  normalizePlaywrightProxy,
  createProxyPool,
  buildDecodoBackconnectUsername,
  buildProxyUrl,
  decodoProvider,
  genericBackconnectProvider,
  getProvider,
  registerProvider,
} from '../../lib/proxy.js';

describe('normalizePlaywrightProxy', () => {
  test('decodes percent-encoded proxy credentials', () => {
    expect(normalizePlaywrightProxy({
      server: 'http://proxy.example.com:10001',
      username: 'sp6incny2a',
      password: 'u4q4iklLj3Jof0%3DIuT',
    })).toEqual({
      server: 'http://proxy.example.com:10001',
      username: 'sp6incny2a',
      password: 'u4q4iklLj3Jof0=IuT',
    });
  });

  test('preserves raw credentials', () => {
    expect(normalizePlaywrightProxy({
      server: 'http://gate.proxy.com:7000',
      username: 'sp6incny2a',
      password: 'u4q4iklLj3Jof0=IuT',
    })).toEqual({
      server: 'http://gate.proxy.com:7000',
      username: 'sp6incny2a',
      password: 'u4q4iklLj3Jof0=IuT',
    });
  });

  test('leaves malformed percent sequences unchanged', () => {
    expect(normalizePlaywrightProxy({
      server: 'http://proxy:1234',
      username: 'user%ZZ',
      password: 'pass%ZZ',
    })).toEqual({
      server: 'http://proxy:1234',
      username: 'user%ZZ',
      password: 'pass%ZZ',
    });
  });

  test('passes through null proxy', () => {
    expect(normalizePlaywrightProxy(null)).toBeNull();
  });
});

describe('decodoProvider', () => {
  test('builds sticky residential username with targeting', () => {
    expect(decodoProvider.buildSessionUsername('sp6incny2a', {
      country: 'us',
      state: 'us_california',
      sessionId: 'browser-abc123',
      sessionDurationMinutes: 10,
    })).toBe('user-sp6incny2a-country-us-state-us_california-session-browser_abc123-sessionduration-10');
  });

  test('sanitizes spaces and punctuation', () => {
    expect(decodoProvider.buildSessionUsername('User Name', {
      country: 'US',
      city: 'New York',
      sessionId: 'ctx:1',
    })).toBe('user-user_name-country-us-city-new_york-session-ctx_1');
  });

  test('declares capabilities', () => {
    expect(decodoProvider.canRotateSessions).toBe(true);
    expect(decodoProvider.launchRetries).toBe(10);
    expect(decodoProvider.launchTimeoutMs).toBe(180000);
    expect(decodoProvider.name).toBe('decodo');
  });
});

describe('genericBackconnectProvider', () => {
  test('passes through username with session suffix', () => {
    expect(genericBackconnectProvider.buildSessionUsername('myuser', {
      sessionId: 'sess-123',
    })).toBe('myuser-sess-123');
  });

  test('returns bare username when no session', () => {
    expect(genericBackconnectProvider.buildSessionUsername('myuser', {})).toBe('myuser');
  });

  test('declares capabilities', () => {
    expect(genericBackconnectProvider.canRotateSessions).toBe(true);
    expect(genericBackconnectProvider.launchRetries).toBe(5);
    expect(genericBackconnectProvider.launchTimeoutMs).toBe(120000);
    expect(genericBackconnectProvider.name).toBe('generic');
  });
});

describe('buildDecodoBackconnectUsername (legacy alias)', () => {
  test('delegates to decodoProvider', () => {
    expect(buildDecodoBackconnectUsername('sp6incny2a', {
      country: 'us',
      sessionId: 'test-1',
    })).toBe('user-sp6incny2a-country-us-session-test_1');
  });
});

describe('getProvider / registerProvider', () => {
  test('returns built-in providers', () => {
    expect(getProvider('decodo')).toBe(decodoProvider);
    expect(getProvider('generic')).toBe(genericBackconnectProvider);
  });

  test('returns null for unknown provider', () => {
    expect(getProvider('nonexistent')).toBeNull();
  });

  test('registers custom provider', () => {
    const custom = {
      name: 'brightdata',
      canRotateSessions: true,
      launchRetries: 3,
      launchTimeoutMs: 90000,
      buildSessionUsername: (base, opts) => `${base}_${opts.sessionId || 'default'}`,
      buildProxyUrl: () => null,
    };
    registerProvider('brightdata', custom);
    expect(getProvider('brightdata')).toBe(custom);
  });
});

describe('createProxyPool', () => {
  test('returns null when no host for round robin', () => {
    expect(createProxyPool({ strategy: 'round_robin', host: '', ports: [10001], username: 'u', password: 'p' })).toBeNull();
  });

  test('returns null when no ports for round robin', () => {
    expect(createProxyPool({ strategy: 'round_robin', host: 'proxy.example.com', ports: [], username: 'u', password: 'p' })).toBeNull();
  });

  test('single port pool', () => {
    const pool = createProxyPool({ strategy: 'round_robin', host: 'proxy.example.com', ports: [7000], username: 'u', password: 'p' });
    expect(pool).not.toBeNull();
    expect(pool.mode).toBe('round_robin');
    expect(pool.canRotateSessions).toBe(false);
    expect(pool.launchRetries).toBe(1);
    expect(pool.launchTimeoutMs).toBe(60000);
    expect(pool.size).toBe(1);
    expect(pool.getLaunchProxy()).toEqual({ server: 'http://proxy.example.com:7000', username: 'u', password: 'p' });
  });

  test('multi-port round-robin', () => {
    const pool = createProxyPool({ strategy: 'round_robin', host: 'proxy.example.com', ports: [10001, 10002, 10003], username: 'u', password: 'p' });
    expect(pool.size).toBe(3);
    expect(pool.getLaunchProxy().server).toBe('http://proxy.example.com:10001');
    expect(pool.getNext().server).toBe('http://proxy.example.com:10001');
    expect(pool.getNext().server).toBe('http://proxy.example.com:10002');
    expect(pool.getNext().server).toBe('http://proxy.example.com:10003');
    expect(pool.getNext().server).toBe('http://proxy.example.com:10001');
  });

  test('backconnect pool with decodo provider (default)', () => {
    const pool = createProxyPool({
      strategy: 'backconnect',
      backconnectHost: 'gate.proxy.com',
      backconnectPort: 7000,
      username: 'sp6incny2a',
      password: 'p',
      country: 'us',
      state: 'us_california',
      sessionDurationMinutes: 10,
    });

    expect(pool.mode).toBe('backconnect');
    expect(pool.canRotateSessions).toBe(true);
    expect(pool.launchRetries).toBe(10);
    expect(pool.launchTimeoutMs).toBe(180000);
    expect(pool.provider).toBe(decodoProvider);

    const launch = pool.getLaunchProxy('browser-1');
    expect(launch.server).toBe('http://gate.proxy.com:7000');
    expect(launch.username).toBe('user-sp6incny2a-country-us-state-us_california-session-browser_1-sessionduration-10');
    expect(launch.password).toBe('p');

    const next = pool.getNext('ctx-1');
    expect(next.username).toBe('user-sp6incny2a-country-us-state-us_california-session-ctx_1-sessionduration-10');
  });

  test('backconnect pool with explicit generic provider', () => {
    const pool = createProxyPool({
      strategy: 'backconnect',
      providerName: 'generic',
      backconnectHost: 'proxy.brightdata.com',
      backconnectPort: 22225,
      username: 'brd-customer-123',
      password: 'secret',
    });

    expect(pool.mode).toBe('backconnect');
    expect(pool.canRotateSessions).toBe(true);
    expect(pool.provider).toBe(genericBackconnectProvider);
    expect(pool.launchRetries).toBe(5);

    const launch = pool.getLaunchProxy('browser-1');
    expect(launch.server).toBe('http://proxy.brightdata.com:22225');
    expect(launch.username).toBe('brd-customer-123-browser-1');
  });

  test('round_robin pool has null provider and no session rotation', () => {
    const pool = createProxyPool({ strategy: 'round_robin', host: 'proxy.example.com', ports: [8080], username: 'u', password: 'p' });
    expect(pool.provider).toBeNull();
    expect(pool.canRotateSessions).toBe(false);
  });
});

describe('buildProxyUrl', () => {
  test('returns null when pool is null', () => {
    expect(buildProxyUrl(null, {})).toBeNull();
  });

  test('builds backconnect proxy URL via provider', () => {
    const config = {
      strategy: 'backconnect',
      username: 'sp6incny2a',
      password: 'u4q4iklLj3Jof0=IuT',
      backconnectHost: 'gate.proxy.com',
      backconnectPort: 7000,
      country: 'us',
    };
    const pool = createProxyPool(config);
    const url = buildProxyUrl(pool, config);
    expect(url).toMatch(/^http:\/\/user-sp6incny2a.*@gate\.proxy\.com:7000$/);
    expect(url).toContain(encodeURIComponent('u4q4iklLj3Jof0=IuT'));
  });

  test('builds round_robin proxy URL', () => {
    const config = {
      strategy: 'round_robin',
      host: 'us.proxy.com',
      ports: [10001, 10002],
      username: 'myuser',
      password: 'mypass',
    };
    const pool = createProxyPool(config);
    const url = buildProxyUrl(pool, config);
    expect(url).toBe('http://myuser:mypass@us.proxy.com:10001');
  });

  test('round_robin without auth', () => {
    const config = {
      strategy: 'round_robin',
      host: 'proxy.local',
      ports: [8080],
      username: '',
      password: '',
    };
    const pool = createProxyPool(config);
    const url = buildProxyUrl(pool, config);
    expect(url).toBe('http://proxy.local:8080');
  });

  test('returns null for backconnect pool with missing password', () => {
    const config = {
      strategy: 'backconnect',
      username: 'user',
      password: '',
      backconnectHost: 'gate.proxy.com',
      backconnectPort: 7000,
    };
    const pool = createProxyPool(config);
    expect(pool).toBeNull();
    expect(buildProxyUrl(pool, config)).toBeNull();
  });
});
