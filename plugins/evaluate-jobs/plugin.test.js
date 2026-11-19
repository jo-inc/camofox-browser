import crypto from 'crypto';
import path from 'path';
import { EventEmitter } from 'events';
import { fileURLToPath } from 'node:url';
import { describe, test, expect, beforeAll, afterAll } from '@jest/globals';
import { launchServer } from '../../lib/launcher.js';
import { loadConfig } from '../../lib/config.js';
import { register } from './index.js';

// Route-level contract for the evaluate-jobs plugin. The server-backed cases are all answered
// before a tab is needed, so they exercise the real wiring (env enablement, auth, body parsing,
// validation, status codes) without launching a browser. The job lifecycle runs against a fake
// ctx whose page.evaluate the test controls.

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TEST_API_KEY = 'test-evaluate-jobs-key-' + crypto.randomUUID();

async function waitForServer(port, maxRetries = 30) {
  for (let i = 0; i < maxRetries; i++) {
    try {
      if ((await fetch(`http://localhost:${port}/health`)).ok) return;
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(`Server failed to start on port ${port}`);
}

function startServer(extraEnv) {
  const cfg = loadConfig();
  const port = Math.floor(3100 + Math.random() * 900);
  const proc = launchServer({
    pluginDir: path.join(__dirname, '../..'),
    port,
    env: { ...cfg.serverEnv, CAMOFOX_API_KEY: TEST_API_KEY, DEBUG_RESPONSES: 'false', ...extraEnv },
    log: { info: () => {}, error: () => {} },
  });
  return { proc, port, baseUrl: `http://localhost:${port}` };
}

function stopServer(proc) {
  return new Promise((resolve) => {
    if (!proc || proc.exitCode !== null) return resolve();
    const timer = setTimeout(() => { proc.kill('SIGKILL'); resolve(); }, 5000);
    proc.on('close', () => { clearTimeout(timer); resolve(); });
    proc.kill('SIGTERM');
  });
}

async function request(baseUrl, method, routePath, body, { auth = true } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (auth) headers.Authorization = `Bearer ${TEST_API_KEY}`;
  const res = await fetch(`${baseUrl}${routePath}`, { method, headers, ...(body ? { body: JSON.stringify(body) } : {}) });
  let data = null;
  try { data = await res.json(); } catch { /* empty body */ }
  return { status: res.status, data };
}

const TAB = 'no-such-tab';
const UNKNOWN_USER = 'unknown-user-' + crypto.randomUUID();

describe('evaluate-jobs routes (server)', () => {
  let enabled;
  let disabled;

  beforeAll(async () => {
    enabled = startServer({ ENABLE_EVALUATE_JOBS: '1' });
    disabled = startServer({ ENABLE_EVALUATE_JOBS: '' });
    await Promise.all([waitForServer(enabled.port), waitForServer(disabled.port)]);
  }, 120000);

  afterAll(async () => {
    await Promise.all([stopServer(enabled?.proc), stopServer(disabled?.proc)]);
  }, 30000);

  const start = (body, opts) => request(enabled.baseUrl, 'POST', `/tabs/${TAB}/evaluate-async`, body, opts);
  const read = (query, opts) => request(enabled.baseUrl, 'GET', `/tabs/${TAB}/evaluate-async/no-such-job?${new URLSearchParams(query)}`, null, opts);

  test('the routes are absent unless the plugin is enabled', async () => {
    const route = `/tabs/${TAB}/evaluate-async`;
    expect((await request(enabled.baseUrl, 'POST', route, {})).status).toBe(400);
    expect((await request(disabled.baseUrl, 'POST', route, {})).status).toBe(404);
  });

  test('both routes require a bearer token', async () => {
    expect((await start({ userId: UNKNOWN_USER, expression: '1' }, { auth: false })).status).toBe(403);
    expect((await read({ userId: UNKNOWN_USER }, { auth: false })).status).toBe(403);
  });

  test.each([
    ['no userId', { expression: '1' }, /userId is required/],
    ['no expression', { userId: UNKNOWN_USER }, /expression is required/],
    ['timeoutMs below 1000', { userId: UNKNOWN_USER, expression: '1', timeoutMs: 500 }, /timeoutMs must be/],
    ['timeoutMs above 900000', { userId: UNKNOWN_USER, expression: '1', timeoutMs: 900001 }, /timeoutMs must be/],
  ])('start rejects %s with 400', async (_label, body, expected) => {
    const { status, data } = await start(body);
    expect(status).toBe(400);
    expect(data.error).toMatch(expected);
  });

  test('start answers 404 for an unknown tab', async () => {
    const { status } = await start({ userId: UNKNOWN_USER, expression: '1' });
    expect(status).toBe(404);
  });

  test('read rejects a missing userId or an out-of-range waitMs, and 404s an unknown job', async () => {
    expect((await read({})).status).toBe(400);
    const badWait = await read({ userId: UNKNOWN_USER, waitMs: '120001' });
    expect(badWait).toMatchObject({ status: 400, data: { code: 'invalid_wait' } });
    const unknown = await read({ userId: UNKNOWN_USER });
    expect(unknown).toMatchObject({ status: 404, data: { code: 'job_not_found' } });
  });
});

describe('evaluate-jobs routes (fake ctx)', () => {
  function setup(settings = {}) {
    const routes = new Map();
    const app = {
      post: (route, ...handlers) => routes.set(`POST ${route}`, handlers.at(-1)),
      get: (route, ...handlers) => routes.set(`GET ${route}`, handlers.at(-1)),
    };
    const scripts = [];
    const page = {
      evaluate: (expression) => new Promise((resolve, reject) => scripts.push({ expression, resolve, reject })),
    };
    const tabState = { page, toolCalls: 0, consecutiveTimeouts: 2, consecutiveFailures: 1 };
    const session = { lastAccess: 0, tabGroups: new Map([['task', new Map([['tab1', tabState]])]]) };
    const events = new EventEmitter();
    const ctx = {
      log: () => {},
      events,
      config: {},
      sessions: new Map([['u1', session]]),
      findTab: (s, tabId) => {
        for (const [listItemId, group] of s.tabGroups) {
          if (group.has(tabId)) return { tabState: group.get(tabId), listItemId, group };
        }
        return null;
      },
      normalizeUserId: (id) => String(id).toLowerCase(),
      safeError: (err) => err.message,
      auth: () => (_req, _res, next) => next(),
      plugin: { name: 'evaluate-jobs', settings },
    };
    register(app, ctx);
    return { routes, scripts, tabState, session, events };
  }

  function call(handler, req) {
    return new Promise((resolve) => {
      const res = {
        statusCode: 200,
        status(code) { this.statusCode = code; return this; },
        json(data) { resolve({ status: this.statusCode, data }); },
      };
      handler({ params: {}, body: {}, query: {}, reqId: 'r1', ...req }, res);
    });
  }

  const startJob = (routes, body, tabId = 'tab1') =>
    call(routes.get('POST /tabs/:tabId/evaluate-async'), { params: { tabId }, body });
  const readJob = (routes, jobId, query, tabId = 'tab1') =>
    call(routes.get('GET /tabs/:tabId/evaluate-async/:jobId'), { params: { tabId, jobId }, query });

  test('registers its own two routes', () => {
    const { routes } = setup();
    expect([...routes.keys()]).toEqual(['POST /tabs/:tabId/evaluate-async', 'GET /tabs/:tabId/evaluate-async/:jobId']);
  });

  test('a job starts at once, is read while running, then long-polled to its result', async () => {
    const { routes, scripts, tabState, session, events } = setup();
    const emitted = [];
    events.on('tab:evaluate', (p) => emitted.push(['evaluate', p]));
    events.on('tab:evaluated', (p) => emitted.push(['evaluated', p]));

    const started = await startJob(routes, { userId: 'U1', expression: 'slowWork()' });
    expect(started.status).toBe(202);
    expect(started.data).toMatchObject({ ok: false, state: 'running' });
    const { jobId } = started.data;
    await new Promise((r) => setImmediate(r));
    expect(scripts.map((s) => s.expression)).toEqual(['slowWork()']);
    expect(tabState).toMatchObject({ toolCalls: 1, consecutiveTimeouts: 0, consecutiveFailures: 0 });
    expect(session.lastAccess).toBeGreaterThan(0);
    expect([...tabState.evaluating][0].until).toBeGreaterThan(Date.now() + 800000);

    expect((await readJob(routes, jobId, { userId: 'u1' })).data.state).toBe('running');
    const polled = readJob(routes, jobId, { userId: 'u1', waitMs: '10000' });
    scripts[0].resolve({ rows: 3 });
    expect(await polled).toMatchObject({ status: 200, data: { ok: true, state: 'done', result: { rows: 3 } } });
    expect(tabState.evaluating.size).toBe(0);
    expect(emitted).toEqual([
      ['evaluate', { userId: 'U1', tabId: 'tab1', expression: 'slowWork()' }],
      ['evaluated', { userId: 'U1', tabId: 'tab1', result: { rows: 3 } }],
    ]);
  });

  test('a job past timeoutMs reads as a timeout and leaves the tab alone', async () => {
    const { routes, tabState } = setup();
    const { data } = await startJob(routes, { userId: 'u1', expression: 'hang()', timeoutMs: 1000 });
    const read = await readJob(routes, data.jobId, { userId: 'u1', waitMs: '5000' });
    expect(read.data).toMatchObject({ ok: false, state: 'timeout', code: 'evaluate_timeout', tabKept: true });
    expect(tabState.page).toBeDefined();
  });

  test('a script that throws reads as an error', async () => {
    const { routes, scripts } = setup();
    const { data } = await startJob(routes, { userId: 'u1', expression: 'boom()' });
    await new Promise((r) => setImmediate(r));
    scripts[0].reject(new Error('ReferenceError: boom is not defined'));
    const read = await readJob(routes, data.jobId, { userId: 'u1', waitMs: '5000' });
    expect(read.data).toMatchObject({ ok: false, state: 'error', error: 'ReferenceError: boom is not defined' });
  });

  test('a job is not readable by another user or through another tab', async () => {
    const { routes } = setup();
    const { data } = await startJob(routes, { userId: 'u1', expression: '1', timeoutMs: 1000 });
    expect((await readJob(routes, data.jobId, { userId: 'someone-else' })).status).toBe(404);
    expect((await readJob(routes, data.jobId, { userId: 'u1' }, 'tab2')).status).toBe(404);
  });

  test('a tab of another session is 404', async () => {
    const { routes } = setup();
    expect((await startJob(routes, { userId: 'someone-else', expression: '1' })).status).toBe(404);
  });

  test('more running jobs than maxRunningPerUser are refused with 429', async () => {
    const { routes } = setup({ maxRunningPerUser: 1 });
    expect((await startJob(routes, { userId: 'u1', expression: 'a', timeoutMs: 1000 })).status).toBe(202);
    const refused = await startJob(routes, { userId: 'u1', expression: 'b', timeoutMs: 1000 });
    expect(refused).toMatchObject({ status: 429, data: { code: 'too_many_jobs' } });
  });
});
