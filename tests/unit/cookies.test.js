const path = require('path');
const crypto = require('crypto');
const { launchServer } = require('../../lib/launcher');
const { loadConfig } = require('../../lib/config');

const TEST_API_KEY = 'test-cookie-key-' + crypto.randomUUID();
let serverProcess = null;
let serverUrl = null;

async function startServerWithApiKey(apiKey) {
  const port = Math.floor(3100 + Math.random() * 900);
  const cfg = loadConfig();
  const pluginDir = path.join(__dirname, '../..');

  serverProcess = launchServer({
    pluginDir,
    port,
    env: { ...cfg.serverEnv, CAMOFOX_API_KEY: apiKey, DEBUG_RESPONSES: 'false' },
    log: { info: () => {}, error: (msg) => console.error(msg) },
  });

  for (let i = 0; i < 30; i++) {
    await new Promise((r) => setTimeout(r, 500));
    try {
      const res = await fetch(`http://localhost:${port}/health`);
      if (res.ok) {
        serverUrl = `http://localhost:${port}`;
        return;
      }
    } catch {}
  }
  throw new Error('Server failed to start');
}

async function startServerWithoutApiKey() {
  const port = Math.floor(3100 + Math.random() * 900);
  const cfg = loadConfig();
  const pluginDir = path.join(__dirname, '../..');

  const env = { ...cfg.serverEnv, DEBUG_RESPONSES: 'false' };
  delete env.CAMOFOX_API_KEY;

  serverProcess = launchServer({
    pluginDir,
    port,
    env,
    log: { info: () => {}, error: (msg) => console.error(msg) },
  });

  for (let i = 0; i < 30; i++) {
    await new Promise((r) => setTimeout(r, 500));
    try {
      const res = await fetch(`http://localhost:${port}/health`);
      if (res.ok) {
        serverUrl = `http://localhost:${port}`;
        return;
      }
    } catch {}
  }
  throw new Error('Server failed to start');
}

function stopServer() {
  return new Promise((resolve) => {
    if (!serverProcess) return resolve();
    serverProcess.on('close', () => {
      serverProcess = null;
      serverUrl = null;
      resolve();
    });
    serverProcess.kill('SIGTERM');
    setTimeout(() => {
      if (serverProcess) serverProcess.kill('SIGKILL');
    }, 5000);
  });
}

async function postCookies(userId, cookies, headers = {}) {
  return fetch(`${serverUrl}/sessions/${encodeURIComponent(userId)}/cookies`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify({ cookies }),
  });
}

describe('Cookie endpoint - field sanitization', () => {
  beforeAll(async () => {
    await startServerWithApiKey(TEST_API_KEY);
  }, 120000);

  afterAll(async () => {
    await stopServer();
  }, 30000);

  test('strips unknown fields from cookies', async () => {
    const cookies = [
      {
        name: 'sess',
        value: 'abc',
        domain: '.example.com',
        path: '/',
        evil: 'payload',
        __proto__: { admin: true },
      },
    ];
    const res = await postCookies('user1', cookies, {
      Authorization: `Bearer ${TEST_API_KEY}`,
    });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.ok).toBe(true);
    expect(data.count).toBe(1);
  });

  test('rejects more than 500 cookies', async () => {
    const cookies = Array.from({ length: 501 }, (_, i) => ({
      name: `c${i}`,
      value: `v${i}`,
      domain: '.example.com',
      path: '/',
    }));
    const res = await postCookies('user1', cookies, {
      Authorization: `Bearer ${TEST_API_KEY}`,
    });
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toContain('Too many cookies');
  });

  test('rejects request with missing cookies field', async () => {
    const res = await fetch(`${serverUrl}/sessions/user1/cookies`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${TEST_API_KEY}`,
      },
      body: JSON.stringify({ data: 'no cookies key' }),
    });
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toContain('Missing');
  });

  test('preserves sameSite field', async () => {
    const cookies = [
      {
        name: 'strict',
        value: 'val',
        domain: '.example.com',
        path: '/',
        sameSite: 'Strict',
      },
    ];
    const res = await postCookies('user1', cookies, {
      Authorization: `Bearer ${TEST_API_KEY}`,
    });
    expect(res.status).toBe(200);
  });
});

describe('Cookie endpoint - with API key', () => {
  beforeAll(async () => {
    await startServerWithApiKey(TEST_API_KEY);
  }, 120000);

  afterAll(async () => {
    await stopServer();
  }, 30000);

  test('rejects request without Authorization header', async () => {
    const res = await postCookies('user1', []);
    expect(res.status).toBe(403);
    const data = await res.json();
    expect(data.error).toBe('Forbidden');
  });

  test('rejects request with wrong API key', async () => {
    const res = await postCookies('user1', [], {
      Authorization: 'Bearer wrong-key',
    });
    expect(res.status).toBe(403);
  });

  test('rejects non-array cookies', async () => {
    const res = await postCookies(
      'user1',
      'not-an-array',
      { Authorization: `Bearer ${TEST_API_KEY}` }
    );
    // Body is { cookies: "not-an-array" } which fails Array.isArray
    const body = await fetch(`${serverUrl}/sessions/user1/cookies`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${TEST_API_KEY}`,
      },
      body: JSON.stringify({ cookies: 'not-an-array' }),
    });
    expect(body.status).toBe(400);
    const data = await body.json();
    expect(data.error).toContain('array');
  });

  test('rejects cookies missing required fields', async () => {
    const res = await postCookies('user1', [{ name: 'foo' }], {
      Authorization: `Bearer ${TEST_API_KEY}`,
    });
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toContain('name, value, and domain');
    expect(data.invalid).toBeDefined();
    expect(data.invalid[0].missing).toContain('value');
    expect(data.invalid[0].missing).toContain('domain');
  });

  test('rejects cookies where name is empty string', async () => {
    const res = await postCookies(
      'user1',
      [{ name: '', value: 'bar', domain: '.example.com' }],
      { Authorization: `Bearer ${TEST_API_KEY}` }
    );
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.invalid[0].missing).toContain('name');
  });

  test('rejects non-object cookie entries', async () => {
    const res = await postCookies('user1', ['not-an-object'], {
      Authorization: `Bearer ${TEST_API_KEY}`,
    });
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.invalid[0].error).toContain('must be an object');
  });

  test('accepts valid cookies', async () => {
    const cookies = [
      {
        name: 'session_id',
        value: 'abc123',
        domain: '.example.com',
        path: '/',
        expires: -1,
        httpOnly: true,
        secure: false,
      },
    ];
    const res = await postCookies('user1', cookies, {
      Authorization: `Bearer ${TEST_API_KEY}`,
    });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.ok).toBe(true);
    expect(data.count).toBe(1);
  });

  test('accepts multiple valid cookies', async () => {
    const cookies = [
      { name: 'a', value: '1', domain: '.example.com', path: '/' },
      { name: 'b', value: '2', domain: '.example.com', path: '/' },
      { name: 'c', value: '3', domain: '.test.com', path: '/' },
    ];
    const res = await postCookies('user2', cookies, {
      Authorization: `Bearer ${TEST_API_KEY}`,
    });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.ok).toBe(true);
    expect(data.count).toBe(3);
  });

  test('returns partial validation errors', async () => {
    const cookies = [
      { name: 'good', value: 'val', domain: '.example.com' },
      { name: '', value: 'val', domain: '.example.com' },
      { name: 'also_bad', value: 'val', domain: '' },
    ];
    const res = await postCookies('user1', cookies, {
      Authorization: `Bearer ${TEST_API_KEY}`,
    });
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.invalid.length).toBe(2);
    expect(data.invalid[0].index).toBe(1);
    expect(data.invalid[1].index).toBe(2);
  });
});

describe('Cookie endpoint - without API key', () => {
  beforeAll(async () => {
    await startServerWithoutApiKey();
  }, 120000);

  afterAll(async () => {
    await stopServer();
  }, 30000);

  test('returns 403 when CAMOFOX_API_KEY is not set', async () => {
    const cookies = [
      { name: 'a', value: '1', domain: '.example.com', path: '/' },
    ];
    const res = await postCookies('user1', cookies);
    expect(res.status).toBe(403);
    const data = await res.json();
    expect(data.error).toContain('disabled');
  });
});
