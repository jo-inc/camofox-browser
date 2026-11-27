// Playwright restores localStorage by navigating a stubbed page to each saved origin and fails newContext() if any
// one navigation fails. An extension (Camoufox's bundled uBlock Origin blocks EasyList's ||html-load.com^$document)
// or a restricted port can fail it, and then every tab for that userId fails. The origin Playwright names is not
// always the culprit: uBlock's block page can abort the next origin's navigation instead.
import fs from 'node:fs/promises';

const STORAGE_STATE_ERROR = 'Error setting storage state:';
const PROBE_CONCURRENCY = 8;
const PROBE_TIMEOUT_MS = 10000;

export function isStorageStateRestoreError(err) {
  return String(err?.message || '').includes(STORAGE_STATE_ERROR);
}

// Playwright's call log lists every saved origin.
function restoreCause(err) {
  const message = String(err?.message || '');
  const after = message.slice(message.indexOf(STORAGE_STATE_ERROR) + STORAGE_STATE_ERROR.length);
  return after.split('\nCall log:')[0].trim().split('\n')[0];
}

function firstLine(err) {
  return String(err?.message || err).split('\n')[0];
}

async function readStorageState(storageState) {
  if (typeof storageState === 'string') return JSON.parse(await fs.readFile(storageState, 'utf8'));
  return storageState;
}

export async function findUnrestorableOrigins(browser, origins, { concurrency = PROBE_CONCURRENCY, timeoutMs = PROBE_TIMEOUT_MS } = {}) {
  const results = new Array(origins.length).fill(null);
  const probe = await browser.newContext();
  try {
    await probe.route('**/*', (route) => route.fulfill({ body: '<html></html>' }).catch(() => {}));
    let next = 0;
    const worker = async () => {
      while (next < origins.length) {
        const i = next++;
        const origin = origins[i];
        let page;
        try {
          page = await probe.newPage();
          await page.goto(origin, { timeout: timeoutMs });
          const landed = new URL(page.url()).origin;
          if (landed !== new URL(origin).origin) results[i] = { origin, error: `landed on ${landed}` };
        } catch (err) {
          results[i] = { origin, error: firstLine(err) };
        } finally {
          await page?.close().catch(() => {});
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(concurrency, origins.length) }, worker));
  } finally {
    await probe.close().catch(() => {});
  }
  return results.filter(Boolean);
}

// A cookies-only fallback is deliberately absent: the next checkpoint would wipe every origin's localStorage.
export async function newContextRestoringStorage(browser, contextOptions, { userId, log, findUnrestorable = findUnrestorableOrigins } = {}) {
  try {
    return await browser.newContext(contextOptions);
  } catch (err) {
    if (!contextOptions?.storageState || !isStorageStateRestoreError(err)) throw err;
    let state;
    try {
      state = await readStorageState(contextOptions.storageState);
    } catch {
      throw err;
    }
    const origins = Array.isArray(state?.origins) ? state.origins : [];
    const failed = origins.length ? await findUnrestorable(browser, origins.map((o) => o.origin)) : [];
    if (!failed.length) throw err;
    const dropped = new Set(failed.map((f) => f.origin));
    const kept = origins.filter((o) => !dropped.has(o.origin));
    log?.('warn', 'storage state restore failed; restoring without the origins that cannot be restored', {
      userId,
      error: restoreCause(err),
      dropped: failed,
      kept: kept.length,
    });
    return await browser.newContext({ ...contextOptions, storageState: { ...state, origins: kept } });
  }
}
