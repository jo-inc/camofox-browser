import crypto from 'crypto';
import path from 'path';
import { EventEmitter } from 'events';
import { fileURLToPath } from 'node:url';
import { describe, test, expect, beforeAll, afterAll } from '@jest/globals';
import { launchServer } from '../../lib/launcher.js';
import { loadConfig } from '../../lib/config.js';
import { register } from './index.js';

// Route-level contract for the network-capture plugin.
//
// The server-backed cases are all rejected before any tab lookup, so they
// exercise the real wiring (env enablement, auth, body parsing, validators,
// status codes) without launching a browser. The success path is covered
// against a fake ctx, since it needs a live tab.

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TEST_API_KEY = 'test-capture-key-' + crypto.randomUUID();

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

describe('network-capture routes (server)', () => {
  beforeAll(async () => {
    const cfg = loadConfig();
    const port = Math.floor(3100 + Math.random() * 900);
    serverProcess = launchServer({
      pluginDir: path.join(__dirname, '../..'),
      port,
      env: {
        ...cfg.serverEnv,
        CAMOFOX_API_KEY: TEST_API_KEY,
        ENABLE_NETWORK_CAPTURE: '1',
        DEBUG_RESPONSES: 'false',
      },
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
});

describe('network-capture routes (fake ctx)', () => {
  function fakePage() {
    const page = new EventEmitter();
    page.off = page.removeListener.bind(page);
    return page;
  }

  function setup() {
    const routes = new Map();
    const app = { post: (route, ...handlers) => routes.set(route, handlers.at(-1)) };
    const page = fakePage();
    const tabState = { page, toolCalls: 0, consecutiveTimeouts: 2, consecutiveFailures: 1 };
    const session = { lastAccess: 0, tabGroups: new Map([['task', new Map([['tab1', tabState]])]]) };
    const events = new EventEmitter();
    const ctx = {
      log: () => {},
      events,
      sessions: new Map([['u1', session]]),
      findTab: (s, tabId) => {
        for (const [listItemId, group] of s.tabGroups) {
          if (group.has(tabId)) return { tabState: group.get(tabId), listItemId, group };
        }
        return null;
      },
      normalizeUserId: String,
      safeError: (err) => err.message,
      failuresTotal: { labels: () => ({ inc: () => {} }) },
      auth: () => (_req, _res, next) => next(),
    };
    register(app, ctx);
    return { routes, page, tabState, session, events };
  }

  function call(handler, params, body) {
    return new Promise((resolve) => {
      const res = {
        statusCode: 200,
        status(code) { this.statusCode = code; return this; },
        json(data) { resolve({ status: this.statusCode, data }); },
      };
      handler({ params, body, reqId: 'r1' }, res);
    });
  }

  test('registers both routes', () => {
    const { routes } = setup();
    expect([...routes.keys()]).toEqual(['/tabs/:tabId/capture-network', '/tabs/:tabId/capture-requests']);
  });

  test('capture-requests returns matching requests from the tab page', async () => {
    const { routes, page, tabState, session, events } = setup();
    const emitted = [];
    events.on('tab:capture-requests', (payload) => emitted.push(payload));

    const pending = call(routes.get('/tabs/:tabId/capture-requests'), { tabId: 'tab1' }, {
      userId: 'u1', urlPattern: 'api', durationMs: 100,
    });
    // Listener is attached synchronously once the tab is resolved.
    await new Promise((r) => setImmediate(r));
    page.emit('request', {
      url: () => 'https://x.test/api/items',
      method: () => 'POST',
      postData: () => '{"q":1}',
      headers: () => ({ 'content-type': 'application/json' }),
    });
    page.emit('request', { url: () => 'https://x.test/static/app.js', method: () => 'GET', postData: () => null, headers: () => ({}) });

    const { status, data } = await pending;
    expect(status).toBe(200);
    expect(data).toMatchObject({ ok: true, captureCount: 1, droppedByLimit: 0 });
    expect(data.captures[0]).toMatchObject({ url: 'https://x.test/api/items', method: 'POST', body: '{"q":1}' });
    expect(page.listenerCount('request')).toBe(0);
    expect(tabState).toMatchObject({ toolCalls: 1, consecutiveTimeouts: 0, consecutiveFailures: 0 });
    expect(session.lastAccess).toBeGreaterThan(0);
    expect(emitted).toEqual([{ userId: 'u1', tabId: 'tab1', captureCount: 1 }]);
  });

  test('capture-network returns 404 for a tab of another session', async () => {
    const { routes } = setup();
    const { status, data } = await call(routes.get('/tabs/:tabId/capture-network'), { tabId: 'tab1' }, {
      userId: 'someone-else', durationMs: 100,
    });
    expect(status).toBe(404);
    expect(data.error).toMatch(/tab not found/i);
  });
});
