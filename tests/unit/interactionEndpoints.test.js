import crypto from 'crypto';
import path from 'path';
import { fileURLToPath } from 'node:url';
import { launchServer } from '../../lib/launcher.js';
import { loadConfig } from '../../lib/config.js';

// Endpoint-level contract for the low-level interaction/capture routes.
//
// Every case here is rejected before any tab lookup, so the tests exercise the
// real Express wiring (auth, body parsing, validators, status codes) without
// launching a browser. The point is that bad client input surfaces as 400 --
// an unvalidated `new RegExp(urlPattern)` or a NaN delta used to reach the
// handler and come back as a 500.

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TEST_API_KEY = 'test-interaction-key-' + crypto.randomUUID();

let serverProcess = null;
let baseUrl = null;

async function waitForServer(port, maxRetries = 30) {
  for (let i = 0; i < maxRetries; i++) {
    try {
      const res = await fetch(`http://localhost:${port}/health`);
      if (res.ok) return;
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(`Server failed to start on port ${port}`);
}

async function post(routePath, body, { auth = true } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (auth) headers.Authorization = `Bearer ${TEST_API_KEY}`;
  const res = await fetch(`${baseUrl}${routePath}`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
  let data = null;
  try { data = await res.json(); } catch { /* empty body */ }
  return { status: res.status, data };
}

const TAB = 'no-such-tab';
const UNKNOWN_USER = 'unknown-user-' + crypto.randomUUID();

beforeAll(async () => {
  const cfg = loadConfig();
  const port = Math.floor(3100 + Math.random() * 900);
  serverProcess = launchServer({
    pluginDir: path.join(__dirname, '../..'),
    port,
    env: { ...cfg.serverEnv, CAMOFOX_API_KEY: TEST_API_KEY, DEBUG_RESPONSES: 'false' },
    log: { info: () => {}, error: () => {} },
  });
  baseUrl = `http://localhost:${port}`;
  await waitForServer(port);
}, 120000);

afterAll(async () => {
  if (!serverProcess) return;
  await new Promise((resolve) => {
    serverProcess.on('close', resolve);
    serverProcess.kill('SIGTERM');
    setTimeout(() => { serverProcess.kill('SIGKILL'); resolve(); }, 5000);
  });
  serverProcess = null;
}, 30000);

describe('POST /tabs/:tabId/mouse-wheel', () => {
  test('requires userId', async () => {
    const { status, data } = await post(`/tabs/${TAB}/mouse-wheel`, { deltaY: 500 });
    expect(status).toBe(400);
    expect(data.error).toMatch(/userId required/i);
  });

  test.each([
    ['both deltas zero', { deltaX: 0, deltaY: 0 }, /non-zero/i],
    ['no deltas at all', {}, /non-zero/i],
    ['non-numeric deltaY', { deltaY: '500' }, /finite number/i],
    ['NaN deltaY', { deltaY: null, deltaX: 'NaN' }, /finite number/i],
    ['delta out of range', { deltaY: 1e9 }, /out of range/i],
    ['x without y', { deltaY: 100, x: 10 }, /provided together/i],
    ['negative coordinate', { deltaY: 100, x: -5, y: 10 }, /out of range/i],
    ['non-string ref', { deltaY: 100, ref: 7 }, /non-empty string/i],
  ])('rejects %s with 400', async (_label, body, expected) => {
    const { status, data } = await post(`/tabs/${TAB}/mouse-wheel`, { userId: UNKNOWN_USER, ...body });
    expect(status).toBe(400);
    expect(data.error).toMatch(expected);
  });

  test('returns 404 for an unknown tab once input is valid', async () => {
    const { status } = await post(`/tabs/${TAB}/mouse-wheel`, { userId: UNKNOWN_USER, deltaY: 500 });
    expect(status).toBe(404);
  });
});

describe.each([
  ['/capture-network'],
  ['/capture-requests'],
])('POST /tabs/:tabId%s', (route) => {
  test('requires a bearer token', async () => {
    const { status } = await post(`/tabs/${TAB}${route}`, { userId: UNKNOWN_USER }, { auth: false });
    expect(status).toBe(403);
  });

  test('requires userId', async () => {
    const { status, data } = await post(`/tabs/${TAB}${route}`, {});
    expect(status).toBe(400);
    expect(data.error).toMatch(/userId required/i);
  });

  test.each([
    ['an invalid regular expression', { urlPattern: 'graphql(' }, /not a valid regular expression/i],
    ['an empty urlPattern', { urlPattern: '' }, /non-empty string/i],
    ['an over-long urlPattern', { urlPattern: 'a'.repeat(201) }, /too long/i],
    ['a catastrophic-backtracking pattern', { urlPattern: '(a+)+$' }, /nested quantifier/i],
    ['durationMs above the cap', { durationMs: 600000 }, /durationMs out of range/i],
    ['durationMs below the floor', { durationMs: 5 }, /durationMs out of range/i],
    ['a non-numeric durationMs', { durationMs: '15000' }, /finite number/i],
    ['maxCaptures out of range', { maxCaptures: 0 }, /maxCaptures out of range/i],
    ['maxBodyBytes out of range', { maxBodyBytes: 50000000 }, /maxBodyBytes out of range/i],
  ])('rejects %s with 400', async (_label, body, expected) => {
    const { status, data } = await post(`/tabs/${TAB}${route}`, { userId: UNKNOWN_USER, ...body });
    expect(status).toBe(400);
    expect(data.error).toMatch(expected);
  });

  test('returns 404 for an unknown tab once input is valid', async () => {
    const { status } = await post(`/tabs/${TAB}${route}`, { userId: UNKNOWN_USER, durationMs: 100 });
    expect(status).toBe(404);
  });
});

describe('POST /tabs/:tabId/init-script', () => {
  test('requires a bearer token', async () => {
    const { status } = await post(`/tabs/${TAB}/init-script`, { userId: UNKNOWN_USER, script: 'void 0' }, { auth: false });
    expect(status).toBe(403);
  });

  test('requires userId', async () => {
    const { status, data } = await post(`/tabs/${TAB}/init-script`, { script: 'void 0' });
    expect(status).toBe(400);
    expect(data.error).toMatch(/userId required/i);
  });

  test.each([
    ['a missing script', {}],
    ['an empty script', { script: '   ' }],
    ['a non-string script', { script: { toString: 1 } }],
  ])('rejects %s with 400', async (_label, body) => {
    const { status, data } = await post(`/tabs/${TAB}/init-script`, { userId: UNKNOWN_USER, ...body });
    expect(status).toBe(400);
    expect(data.error).toMatch(/script/i);
  });

  test('returns 404 for an unknown tab once input is valid', async () => {
    const { status } = await post(`/tabs/${TAB}/init-script`, { userId: UNKNOWN_USER, script: 'window.__x = 1;' });
    expect(status).toBe(404);
  });
});
