import { describe, test, expect } from '@jest/globals';
import { createJobStore, jobView, parseStartParams, parseWaitMs, TIMEOUT_MAX_MS, WAIT_MAX_MS } from './jobs.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

describe('parseStartParams', () => {
  test('defaults timeoutMs to the 15 minute ceiling', () => {
    expect(parseStartParams({ expression: '1' })).toEqual({ ok: true, params: { expression: '1', timeoutMs: TIMEOUT_MAX_MS } });
  });

  test.each([
    [{}, 'invalid_expression'],
    [{ expression: '' }, 'invalid_expression'],
    [{ expression: 42 }, 'invalid_expression'],
    [{ expression: '1', timeoutMs: 999 }, 'invalid_timeout'],
    [{ expression: '1', timeoutMs: TIMEOUT_MAX_MS + 1 }, 'invalid_timeout'],
    [{ expression: '1', timeoutMs: 1500.5 }, 'invalid_timeout'],
    [{ expression: '1', timeoutMs: '5000' }, 'invalid_timeout'],
  ])('rejects %j', (body, code) => {
    expect(parseStartParams(body)).toMatchObject({ ok: false, code });
  });
});

describe('parseWaitMs', () => {
  test('is 0 when absent', () => {
    expect(parseWaitMs(undefined)).toEqual({ ok: true, waitMs: 0 });
  });

  test('reads a query string number', () => {
    expect(parseWaitMs('2500')).toEqual({ ok: true, waitMs: 2500 });
  });

  test.each(['-1', String(WAIT_MAX_MS + 1), 'soon', '1.5'])('rejects %s', (value) => {
    expect(parseWaitMs(value)).toMatchObject({ ok: false, code: 'invalid_wait' });
  });
});

describe('job store', () => {
  const owner = { userId: 'u1', tabId: 't1' };

  test('a job runs, settles with its result and is read back by its owner only', async () => {
    const store = createJobStore();
    const { jobId, job } = store.start({ ...owner, timeoutMs: 5000, run: () => sleep(20).then(() => 9) });
    expect(jobView(jobId, job)).toMatchObject({ ok: false, state: 'running' });
    await store.wait(job, 5000);
    expect(jobView(jobId, store.get(jobId, owner))).toMatchObject({ ok: true, state: 'done', result: 9 });
    expect(store.get(jobId, { userId: 'u2', tabId: 't1' })).toBeNull();
    expect(store.get(jobId, { userId: 'u1', tabId: 't2' })).toBeNull();
    expect(store.get('no-such-job', owner)).toBeNull();
  });

  test('a script past its deadline is a timeout that keeps the tab', async () => {
    const store = createJobStore();
    const { jobId, job } = store.start({ ...owner, timeoutMs: 30, run: () => new Promise(() => {}) });
    await store.wait(job, 2000);
    expect(jobView(jobId, job)).toMatchObject({ ok: false, state: 'timeout', code: 'evaluate_timeout', tabKept: true });
  });

  test('a script that throws, or throws before returning a promise, is an error', async () => {
    const store = createJobStore();
    const rejected = store.start({ ...owner, timeoutMs: 5000, run: () => Promise.reject(new Error('boom')) });
    const thrown = store.start({ ...owner, timeoutMs: 5000, run: () => { throw new Error('sync boom'); } });
    await Promise.all([rejected.job.settled, thrown.job.settled]);
    expect(jobView(rejected.jobId, rejected.job)).toMatchObject({ ok: false, state: 'error', error: 'boom' });
    expect(jobView(thrown.jobId, thrown.job)).toMatchObject({ ok: false, state: 'error', error: 'sync boom' });
  });

  test('wait returns at waitMs while the job runs on', async () => {
    const store = createJobStore();
    const { job } = store.start({ ...owner, timeoutMs: 1000, run: () => new Promise(() => {}) });
    const began = Date.now();
    await store.wait(job, 50);
    expect(Date.now() - began).toBeLessThan(1000);
    expect(job.state).toBe('running');
  });

  test('a finished job is dropped ttlMs after it finishes', async () => {
    const store = createJobStore({ ttlMs: 30 });
    const { jobId, job } = store.start({ ...owner, timeoutMs: 5000, run: () => 1 });
    await job.settled;
    expect(store.get(jobId, owner)).not.toBeNull();
    await sleep(80);
    expect(store.get(jobId, owner)).toBeNull();
    expect(store.size).toBe(0);
  });

  test('refuses a job past maxRunningPerUser, counting only that user\'s running jobs', async () => {
    const store = createJobStore({ maxRunningPerUser: 2 });
    const never = () => new Promise(() => {});
    store.start({ ...owner, timeoutMs: 1000, run: never });
    const { job } = store.start({ ...owner, timeoutMs: 5000, run: () => 1 });
    await job.settled;
    expect(store.start({ ...owner, timeoutMs: 1000, run: never })).not.toBeNull();
    expect(store.start({ ...owner, timeoutMs: 1000, run: never })).toBeNull();
    expect(store.start({ userId: 'u2', tabId: 't9', timeoutMs: 1000, run: never })).not.toBeNull();
    expect(store.runningFor('u1')).toBe(2);
  });

  test('elapsedMs stops when the job finishes', async () => {
    let clock = 1000;
    const store = createJobStore({ now: () => clock });
    const { jobId, job } = store.start({ ...owner, timeoutMs: 5000, run: () => 'x' });
    clock = 1250;
    await job.settled;
    clock = 9000;
    expect(jobView(jobId, job, () => clock).elapsedMs).toBe(250);
  });
});
