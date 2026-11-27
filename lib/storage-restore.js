// Playwright restores localStorage by navigating a stubbed page to each saved origin and fails newContext() if any
// one navigation fails. An extension (Camoufox's bundled uBlock Origin blocks EasyList's ||html-load.com^$document)
// or a restricted port can fail it, and then every tab for that userId fails. The origin Playwright names is not
// always the culprit: uBlock's block page can abort the next origin's navigation instead.
//
// Playwright's restore script also asks each origin for its service workers and IndexedDB databases so it can clear
// them. A new context has none, but asking makes the browser set up that origin's storage, which from Firefox 154 on
// (Camoufox 158) costs ~150 ms an origin with the profile on disk: a profile with 100+ origins took 25-30 s to open.
// So Playwright restores the cookies and the origins that hold IndexedDB, and this module writes the other origins'
// localStorage.
import fs from 'node:fs/promises';

const STORAGE_STATE_ERROR = 'Error setting storage state:';
const PROBE_CONCURRENCY = 8;
const PROBE_TIMEOUT_MS = 10000;
const STUB_BODY = '<html></html>';
const RESTORE_PASSES = 3;

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

function stubEveryRequest(target) {
  return target.route('**/*', (route) => route.fulfill({ body: STUB_BODY }).catch(() => {}));
}

export async function findUnrestorableOrigins(browser, origins, { concurrency = PROBE_CONCURRENCY, timeoutMs = PROBE_TIMEOUT_MS } = {}) {
  const results = new Array(origins.length).fill(null);
  const probe = await browser.newContext();
  try {
    await stubEveryRequest(probe);
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
async function newContextDroppingUnrestorable(browser, contextOptions, state, { userId, log, findUnrestorable }) {
  try {
    return await browser.newContext(contextOptions);
  } catch (err) {
    const origins = state.origins;
    if (!origins.length || !isStorageStateRestoreError(err)) throw err;
    const failed = await findUnrestorable(browser, origins.map((o) => o.origin));
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

function writeLocalStorage(entries) {
  globalThis.localStorage.clear();
  for (const { name, value } of entries) globalThis.localStorage.setItem(name, value);
}

export async function restoreLocalStorage(context, origins, { timeoutMs = PROBE_TIMEOUT_MS } = {}) {
  const dropped = [];
  let failedAttempts = 0;
  let page = null;
  const openPage = async () => {
    const opened = await context.newPage();
    await stubEveryRequest(opened);
    return opened;
  };
  const restoreOn = async (target, { origin, localStorage }) => {
    await target.goto(origin, { timeout: timeoutMs });
    const landed = new URL(target.url()).origin;
    if (landed !== new URL(origin).origin) throw new Error(`landed on ${landed}`);
    await target.evaluate(writeLocalStorage, localStorage);
  };
  try {
    for (const saved of origins) {
      page ??= await openPage();
      try {
        await restoreOn(page, saved);
        continue;
      } catch {
        // Perhaps the previous origin's block page, not this origin: try it once more on a fresh page.
        failedAttempts += 1;
      }
      await page.close().catch(() => {});
      page = await openPage();
      try {
        await restoreOn(page, saved);
      } catch (err) {
        dropped.push({ origin: saved.origin, error: firstLine(err) });
        await page.close().catch(() => {});
        page = null;
      }
    }
  } finally {
    await page?.close().catch(() => {});
  }
  return { dropped, clean: failedAttempts === 0 };
}

export async function newContextRestoringStorage(browser, contextOptions, { userId, log, findUnrestorable = findUnrestorableOrigins, timeoutMs } = {}) {
  if (!contextOptions?.storageState) return await browser.newContext(contextOptions);
  let state;
  try {
    state = await readStorageState(contextOptions.storageState);
  } catch {
    // Let Playwright report an unreadable file as it always has.
    return await browser.newContext(contextOptions);
  }
  const origins = Array.isArray(state?.origins) ? state.origins : [];
  const withIndexedDB = origins.filter((o) => o?.indexedDB?.length);
  const localOnly = origins.filter((o) => !o?.indexedDB?.length && o?.localStorage?.length);
  const playwrightState = { ...state, origins: withIndexedDB };
  const build = async (saved) => {
    const context = await newContextDroppingUnrestorable(browser, { ...contextOptions, storageState: playwrightState }, playwrightState, { userId, log, findUnrestorable });
    try {
      return { context, ...(await restoreLocalStorage(context, saved, { timeoutMs })) };
    } catch (err) {
      await context.close().catch(() => {});
      throw err;
    }
  };
  // A failed navigation leaves its page's origin (or uBlock's block page) among the origins Playwright saves at every
  // checkpoint, and that checkpoint would then fail navigating back there, so such a context is rebuilt with only the
  // origins that restored. uBlock blocks nothing until its lists load just after launch, hence a few passes.
  let saved = localOnly;
  const dropped = [];
  for (let pass = 1; ; pass++) {
    const built = await build(saved);
    if (built.clean) {
      if (dropped.length) {
        log?.('warn', 'storage state restore: dropped the origins that cannot be restored', { userId, dropped, kept: saved.length });
      }
      return built.context;
    }
    await built.context.close().catch(() => {});
    if (pass === RESTORE_PASSES) {
      const failing = built.dropped.map((d) => d.origin).join(', ') || 'an origin that failed once';
      throw new Error(`storage state restore did not complete cleanly in ${RESTORE_PASSES} passes: ${failing}`);
    }
    const failed = new Set(built.dropped.map((d) => d.origin));
    dropped.push(...built.dropped);
    saved = saved.filter((o) => !failed.has(o.origin));
  }
}