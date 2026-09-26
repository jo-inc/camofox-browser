/**
 * Browser-level network capture used by /tabs/:tabId/capture-network and
 * /tabs/:tabId/capture-requests.
 *
 * The subtle part is response bodies. `response.text()` is async, so a response
 * that arrives just before the capture window closes still has its body in
 * flight when the timer fires. Detaching the listener and responding at that
 * point silently drops it. Every started read is therefore tracked and awaited
 * (under its own bounded grace period) before the captures are returned; a slot
 * is pushed synchronously on arrival so ordering and the maxCaptures budget are
 * decided at event time, not at completion time.
 */

export const BODY_DRAIN_TIMEOUT_MS = 5000;
export const PENDING_BODY_MARKER = '__BODY_PENDING__';
export const BODY_ERROR_PREFIX = '__BODY_ERROR__:';
export const TRUNCATED_MARKER = '__TRUNCATED__';

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Promise.race against a timer that is always cleared, so no handle leaks. */
async function raceWithTimeout(promise, ms) {
  let timer;
  const timeout = new Promise((resolve) => { timer = setTimeout(resolve, ms); });
  try {
    await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

function truncate(body, maxBodyBytes) {
  const text = typeof body === 'string' ? body : String(body ?? '');
  return text.length > maxBodyBytes ? text.slice(0, maxBodyBytes) + TRUNCATED_MARKER : text;
}

/**
 * Attach a page.on('response') listener for `durationMs` and return matching
 * responses with their bodies.
 *
 * @param {object} page Playwright page (only on/off are used)
 * @param {object} opts
 * @param {RegExp} opts.regex compiled URL filter (validated by compileUrlPattern)
 * @param {number} opts.durationMs capture window
 * @param {number} opts.maxBodyBytes per-body cap before truncation
 * @param {number} opts.maxCaptures hard cap on captured responses
 * @param {number} [opts.drainTimeoutMs] grace period for in-flight body reads
 * @param {(ms: number) => Promise<void>} [opts.sleep] injectable for tests
 * @returns {Promise<{captures: object[], captureCount: number, droppedByLimit: number, pendingBodies: number}>}
 */
export async function captureResponses(page, opts) {
  const {
    regex,
    durationMs,
    maxBodyBytes,
    maxCaptures,
    drainTimeoutMs = BODY_DRAIN_TIMEOUT_MS,
    sleep = defaultSleep,
  } = opts;

  const captures = [];
  const pending = new Set();
  let droppedByLimit = 0;

  const handler = (response) => {
    let url;
    try {
      url = response.url();
    } catch {
      return; // response object already disposed with the page
    }
    if (!regex.test(url)) return;
    if (captures.length >= maxCaptures) { droppedByLimit++; return; }

    let status = 0;
    try { status = response.status(); } catch { /* keep 0 */ }

    // Reserve the slot synchronously: ordering and the cap must not depend on
    // which body read finishes first.
    const slot = { url, status, len: 0, body: PENDING_BODY_MARKER };
    captures.push(slot);

    const read = (async () => {
      try {
        // Truncation applies to the body only: a failed read is a diagnostic,
        // and slicing it to maxBodyBytes would mangle the reason.
        slot.body = truncate(await response.text(), maxBodyBytes);
      } catch (e) {
        slot.body = `${BODY_ERROR_PREFIX}${e.message}`;
      }
      slot.len = slot.body.length;
    })();
    pending.add(read);
    read.finally(() => pending.delete(read));
  };

  page.on('response', handler);
  try {
    await sleep(durationMs);
  } finally {
    page.off('response', handler);
  }

  // Responses that landed near the deadline still have their body in flight.
  if (pending.size > 0) {
    await raceWithTimeout(Promise.allSettled([...pending]), drainTimeoutMs);
  }

  const pendingBodies = captures.reduce((n, c) => n + (c.body === PENDING_BODY_MARKER ? 1 : 0), 0);
  return { captures, captureCount: captures.length, droppedByLimit, pendingBodies };
}

/**
 * Attach a page.on('request') listener for `durationMs` and return matching
 * requests. Request post-data is synchronous, so there is nothing to drain.
 *
 * @returns {Promise<{captures: object[], captureCount: number, droppedByLimit: number}>}
 */
export async function captureRequests(page, opts) {
  const {
    regex,
    durationMs,
    maxBodyBytes,
    maxCaptures,
    includeHeaders = true,
    sleep = defaultSleep,
  } = opts;

  const captures = [];
  let droppedByLimit = 0;

  const handler = (request) => {
    try {
      const url = request.url();
      if (!regex.test(url)) return;
      if (captures.length >= maxCaptures) { droppedByLimit++; return; }
      const body = truncate(request.postData() || '', maxBodyBytes);
      captures.push({
        url,
        method: request.method(),
        len: body.length,
        body,
        headers: includeHeaders ? request.headers() : {},
      });
    } catch (e) {
      captures.push({ err: e.message });
    }
  };

  page.on('request', handler);
  try {
    await sleep(durationMs);
  } finally {
    page.off('request', handler);
  }

  return { captures, captureCount: captures.length, droppedByLimit };
}
