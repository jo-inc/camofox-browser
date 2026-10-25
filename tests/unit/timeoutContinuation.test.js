import { readFileSync } from 'fs';
import { browserErrorCode, browserErrorRecovery, browserErrorStatus } from '../../lib/browser-errors.js';
import { startServer, stopServer, getServerUrl } from '../helpers/startServer.js';
import { createClient } from '../helpers/client.js';

const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

describe('timed-out tab operations', () => {
  let serverUrl;

  beforeAll(async () => {
    await startServer(0, { HANDLER_TIMEOUT_MS: '5000' });
    serverUrl = getServerUrl();
  }, 120000);

  afterAll(async () => {
    await stopServer();
  }, 30000);

  test('marks native mouse calls as bounded tab-destroying operations', () => {
    const source = readFileSync(new URL('../../server.js', import.meta.url), 'utf8');
    const clickStart = source.indexOf("app.post('/tabs/:tabId/click'");
    const clickRoute = source.slice(clickStart, source.indexOf("app.post('/tabs/:tabId/upload'", clickStart));

    for (const action of ['move', 'down', 'up']) {
      expect(clickRoute).toContain(`withTimeout(tabState.page.mouse.${action}`);
    }
    expect(clickRoute).toContain("destroyTimedOutTab(session, tabId, 'operation_timeout', userId)");
  });

  test('allows tab creation to finish its one-session recovery', () => {
    const source = readFileSync(new URL('../../server.js', import.meta.url), 'utf8');
    const createRoute = source.slice(source.indexOf("app.post('/tabs', async (req, res) => {"), source.indexOf('// Navigate', source.indexOf("app.post('/tabs', async (req, res) => {")));

    expect(source).toContain('function tabCreateRequestTimeoutMs()');
    expect(source).toContain('return Math.max(requestTimeoutMs(), (NEW_PAGE_TIMEOUT_MS * 2) + 5000);');
    expect(createRoute).toContain("})(), tabCreateRequestTimeoutMs(), 'tab create');");
  });

  test('returns a stable recoverable error after timeout cleanup', () => {
    const error = Object.assign(new Error('action timed out after 5000ms'), { code: 'tab_timeout' });

    expect(browserErrorStatus(error)).toBe(410);
    expect(browserErrorCode(error)).toBe('tab_timeout');
    expect(browserErrorRecovery(error)).toBe('create_new_tab');
  });

  test('keeps the tab and its page after an evaluate timeout', async () => {
    const client = createClient(serverUrl);
    const { tabId } = await client.createTab();

    try {
      await client.evaluate(tabId, 'window.__kept = 1');
      const first = client.evaluate(tabId, 'new Promise(() => {})').catch(error => error);
      await wait(50);
      const queued = client.evaluate(tabId, '42');
      const [firstError, queuedResult] = await Promise.all([first, queued]);

      expect(firstError.status).toBe(504);
      expect(firstError.data.code).toBe('evaluate_timeout');
      expect(firstError.data.tabKept).toBe(true);
      expect(queuedResult.result).toBe(42);
      expect((await client.evaluate(tabId, 'window.__kept')).result).toBe(1);
    } finally {
      await client.cleanup();
    }
  }, 30000);

  test('a caller timeoutMs outlives the handler timeout without blocking the tab', async () => {
    const client = createClient(serverUrl);
    const { tabId } = await client.createTab();
    const evaluate = (expression, timeoutMs) => client.request(
      'POST', `/tabs/${tabId}/evaluate`, { userId: client.userId, expression, timeoutMs }, { timeout: 20000 });

    try {
      const slow = evaluate('new Promise(r => setTimeout(() => r(7), 7000))', 10000);
      await wait(200);
      // The handler timeout is 5000 here: the slow call is past it, and a lock-holding
      // evaluate would make this one wait the 35 s lock queue.
      const quick = await evaluate('42');
      expect(quick.result).toBe(42);
      expect((await slow).result).toBe(7);
      const timedOut = await evaluate('new Promise(() => {})', 1000).catch(error => error);
      expect(timedOut.status).toBe(504);
      expect((await evaluate('1')).result).toBe(1);
    } finally {
      await client.cleanup();
    }
  }, 30000);

  test('an async evaluate is read back later, and its timeout keeps the tab', async () => {
    const client = createClient(serverUrl);
    const { tabId } = await client.createTab();
    const start = (expression, timeoutMs) => client.request(
      'POST', `/tabs/${tabId}/evaluate`, { userId: client.userId, expression, async: true, timeoutMs });
    const read = (jobId, waitMs = 0, userId = client.userId) => client.request(
      'GET', `/tabs/${tabId}/evaluate/${jobId}?${new URLSearchParams({ userId, waitMs: String(waitMs) })}`, null, { timeout: 20000 });

    try {
      const job = await start('new Promise(r => setTimeout(() => r(9), 2000))', 10000);
      expect(job.jobId).toBeTruthy();
      expect(job.state).toBe('running');
      expect((await read(job.jobId)).state).toBe('running');
      const done = await read(job.jobId, 10000);
      expect(done).toMatchObject({ ok: true, state: 'done', result: 9 });
      expect((await read(job.jobId)).result).toBe(9);

      const slow = await start('new Promise(() => {})', 1000);
      const timedOut = await read(slow.jobId, 5000);
      expect(timedOut).toMatchObject({ state: 'timeout', code: 'evaluate_timeout', tabKept: true });
      expect((await client.evaluate(tabId, '1')).result).toBe(1);

      const failed = await start('Promise.reject(new Error("boom"))', 5000);
      expect(await read(failed.jobId, 5000)).toMatchObject({ ok: false, state: 'error' });

      const stranger = await read(job.jobId, 0, 'someone-else').catch((e) => e);
      expect(stranger.status).toBe(404);
    } finally {
      await client.cleanup();
    }
  }, 30000);

  test('rejects a timeoutMs outside 1000..900000', async () => {
    const client = createClient(serverUrl);
    const { tabId } = await client.createTab();

    try {
      for (const timeoutMs of [999, 900001, 'soon', 1500.5]) {
        const error = await client.request(
          'POST', `/tabs/${tabId}/evaluate`, { userId: client.userId, expression: '1', timeoutMs }).catch(e => e);
        expect(error.status).toBe(400);
      }
    } finally {
      await client.cleanup();
    }
  }, 30000);
});
