import crypto from 'crypto';

export const TIMEOUT_MIN_MS = 1000;
export const TIMEOUT_MAX_MS = 15 * 60 * 1000;
export const WAIT_MAX_MS = 120000;
export const JOB_TTL_MS = 15 * 60 * 1000;
export const MAX_RUNNING_PER_USER = 10;

class JobTimeoutError extends Error {}

export function parseStartParams(body) {
  const { expression } = body;
  if (typeof expression !== 'string' || expression.length === 0) {
    return { ok: false, error: 'expression is required', code: 'invalid_expression' };
  }
  const timeoutMs = body.timeoutMs ?? TIMEOUT_MAX_MS;
  if (!Number.isInteger(timeoutMs) || timeoutMs < TIMEOUT_MIN_MS || timeoutMs > TIMEOUT_MAX_MS) {
    return { ok: false, error: `timeoutMs must be an integer from ${TIMEOUT_MIN_MS} to ${TIMEOUT_MAX_MS}`, code: 'invalid_timeout' };
  }
  return { ok: true, params: { expression, timeoutMs } };
}

export function parseWaitMs(value) {
  if (value === undefined || value === '') return { ok: true, waitMs: 0 };
  const waitMs = Number(value);
  if (!Number.isInteger(waitMs) || waitMs < 0 || waitMs > WAIT_MAX_MS) {
    return { ok: false, error: `waitMs must be an integer from 0 to ${WAIT_MAX_MS}`, code: 'invalid_wait' };
  }
  return { ok: true, waitMs };
}

// Jobs live in memory only, scoped to the tab and user that started them, and are dropped
// ttlMs after they finish. A server restart loses them, as it loses the tabs they ran in.
export function createJobStore({ ttlMs = JOB_TTL_MS, maxRunningPerUser = MAX_RUNNING_PER_USER, now = Date.now } = {}) {
  const jobs = new Map();

  function runningFor(userId) {
    let count = 0;
    for (const job of jobs.values()) if (job.userId === userId && job.state === 'running') count++;
    return count;
  }

  function start({ userId, tabId, timeoutMs, run }) {
    if (runningFor(userId) >= maxRunningPerUser) return null;
    const jobId = crypto.randomUUID();
    const job = { userId, tabId, state: 'running', startedAt: now() };
    let timer;
    const deadline = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new JobTimeoutError(`evaluate timed out after ${timeoutMs}ms`)), timeoutMs);
    });
    job.settled = Promise.race([Promise.resolve().then(run), deadline])
      .then(
        (result) => Object.assign(job, { state: 'done', result }),
        (err) => Object.assign(job, { state: err instanceof JobTimeoutError ? 'timeout' : 'error', error: err?.message ?? String(err) }),
      )
      .finally(() => {
        clearTimeout(timer);
        job.finishedAt = now();
        setTimeout(() => jobs.delete(jobId), ttlMs).unref?.();
      });
    jobs.set(jobId, job);
    return { jobId, job };
  }

  function get(jobId, { userId, tabId }) {
    const job = jobs.get(jobId);
    return job && job.userId === userId && job.tabId === tabId ? job : null;
  }

  async function wait(job, waitMs) {
    if (job.state !== 'running' || waitMs <= 0) return;
    let timer;
    await Promise.race([job.settled, new Promise((resolve) => { timer = setTimeout(resolve, waitMs); })]);
    clearTimeout(timer);
  }

  return { start, get, wait, runningFor, get size() { return jobs.size; } };
}

export function jobView(jobId, job, now = Date.now) {
  return {
    ok: job.state === 'done',
    jobId,
    state: job.state,
    ...(job.state === 'done' ? { result: job.result } : {}),
    ...(job.error ? { error: job.error } : {}),
    ...(job.state === 'timeout' ? { code: 'evaluate_timeout', tabKept: true } : {}),
    elapsedMs: (job.finishedAt ?? now()) - job.startedAt,
  };
}
