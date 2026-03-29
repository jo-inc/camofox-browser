import {
  normalizePlaywrightProxy,
  createProxyPool,
  buildDecodoBackconnectUsername,
} from '../../lib/proxy.js';

describe('normalizePlaywrightProxy', () => {
  test('decodes percent-encoded proxy credentials', () => {
    expect(normalizePlaywrightProxy({
      server: 'http://us.decodo.com:10001',
      username: 'sp6incny2a',
      password: 'u4q4iklLj3Jof0%3DIuT',
    })).toEqual({
      server: 'http://us.decodo.com:10001',
      username: 'sp6incny2a',
      password: 'u4q4iklLj3Jof0=IuT',
    });
  });

  test('preserves raw credentials', () => {
    expect(normalizePlaywrightProxy({
      server: 'http://gate.decodo.com:7000',
      username: 'sp6incny2a',
      password: 'u4q4iklLj3Jof0=IuT',
    })).toEqual({
      server: 'http://gate.decodo.com:7000',
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

describe('buildDecodoBackconnectUsername', () => {
  test('builds sticky residential username with targeting', () => {
    expect(buildDecodoBackconnectUsername('sp6incny2a', {
      country: 'us',
      state: 'us_california',
      sessionId: 'browser-abc123',
      sessionDurationMinutes: 10,
    })).toBe('user-sp6incny2a-country-us-state-us_california-session-browser_abc123-sessionduration-10');
  });

  test('sanitizes spaces and punctuation', () => {
    expect(buildDecodoBackconnectUsername('User Name', {
      country: 'US',
      city: 'New York',
      sessionId: 'ctx:1',
    })).toBe('user-user_name-country-us-city-new_york-session-ctx_1');
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
    const pool = createProxyPool({ strategy: 'round_robin', host: 'us.decodo.com', ports: [7000], username: 'u', password: 'p' });
    expect(pool).not.toBeNull();
    expect(pool.mode).toBe('round_robin');
    expect(pool.size).toBe(1);
    expect(pool.getLaunchProxy()).toEqual({ server: 'http://us.decodo.com:7000', username: 'u', password: 'p' });
    expect(pool.getNext()).toEqual({ server: 'http://us.decodo.com:7000', username: 'u', password: 'p' });
    expect(pool.getNext()).toEqual({ server: 'http://us.decodo.com:7000', username: 'u', password: 'p' });
  });

  test('multi-port round-robin', () => {
    const pool = createProxyPool({ strategy: 'round_robin', host: 'us.decodo.com', ports: [10001, 10002, 10003], username: 'u', password: 'p' });
    expect(pool.size).toBe(3);
    expect(pool.getLaunchProxy().server).toBe('http://us.decodo.com:10001');
    expect(pool.getNext().server).toBe('http://us.decodo.com:10001');
    expect(pool.getNext().server).toBe('http://us.decodo.com:10002');
    expect(pool.getNext().server).toBe('http://us.decodo.com:10003');
    expect(pool.getNext().server).toBe('http://us.decodo.com:10001');
    expect(pool.getNext().server).toBe('http://us.decodo.com:10002');
  });

  test('backconnect pool uses gate endpoint with sticky sessions', () => {
    const pool = createProxyPool({
      strategy: 'backconnect',
      backconnectHost: 'gate.decodo.com',
      backconnectPort: 7000,
      username: 'sp6incny2a',
      password: 'p',
      country: 'us',
      state: 'us_california',
      sessionDurationMinutes: 10,
    });

    expect(pool.mode).toBe('backconnect');
    const launch = pool.getLaunchProxy('browser-1');
    expect(launch.server).toBe('http://gate.decodo.com:7000');
    expect(launch.username).toBe('user-sp6incny2a-country-us-state-us_california-session-browser_1-sessionduration-10');
    expect(launch.password).toBe('p');

    const next = pool.getNext('ctx-1');
    expect(next.server).toBe('http://gate.decodo.com:7000');
    expect(next.username).toBe('user-sp6incny2a-country-us-state-us_california-session-ctx_1-sessionduration-10');
  });
});
