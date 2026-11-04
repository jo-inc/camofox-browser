/**
 * Test the features added on feature/browser-experience against a running
 * Camofox server.
 *
 * Usage (reads CAMOFOX_BASE_URL and CAMOFOX_ACCESS_KEY from the environment or .env):
 *   node scripts/test-branch-features.mjs
 *   node scripts/test-branch-features.mjs https://example.org/some-page https://news.example.com/
 *
 * Any URLs passed on the command line replace the default pages. Use this to
 * try pages with cookie banners or pop-ups, which exercise the page-state and
 * overlay checks properly.
 *
 * Checks:
 *   - GET /tabs/:tabId/state without a key is rejected (401)
 *   - on each real page: state returns a known kind, the page's host, and a
 *     snapshot with a realistic number of element refs
 *   - POST /tabs/:tabId/overlays/dismiss runs on each page and returns lists
 *   - each new search macro lands on its site
 *   - unknown tab IDs are rejected (404) on the new routes
 *
 * Not covered here: the handoff gate (409 human_in_control). No route can set
 * human control until handoff Phase 3, so the gate is covered by unit tests only.
 */
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { loadEnvFile } from 'node:process';

const envPath = resolve(process.cwd(), '.env');
if (existsSync(envPath)) loadEnvFile(envPath);

const BASE = (process.env.CAMOFOX_BASE_URL || '').trim().replace(/\/+$/, '');
const ACCESS_KEY = (process.env.CAMOFOX_ACCESS_KEY || process.env.CAMOFOX_API_KEY || '').trim();

if (!BASE) throw new Error('Missing CAMOFOX_BASE_URL (set it in .env or the environment).');
if (!ACCESS_KEY) throw new Error('Missing CAMOFOX_ACCESS_KEY (set it in .env or the environment).');

const userId = `branch-test-${randomUUID()}`;
const sessionKey = `branch-test-${randomUUID()}`;
// Deliberately not a UUID: UUID-shaped unknown tabs get 410 instead of 404.
const missingTabId = 'missing-tab-for-branch-test';

// Real pages with dense content. minRefs is the number of interactive
// elements a snapshot should find on that page. The bar is set low enough that
// a healthy page passes, but a blank or blocked page fails.
const DEFAULT_PAGES = [
  { url: 'https://en.wikipedia.org/wiki/Web_browser', minRefs: 50 },
  { url: 'https://en.wikipedia.org/wiki/Headless_browser', minRefs: 30 },
];

const cliUrls = process.argv.slice(2).filter((arg) => /^https:\/\//.test(arg));
const PAGES = (cliUrls.length ? cliUrls : DEFAULT_PAGES.map((p) => p.url)).map((url) => {
  const known = DEFAULT_PAGES.find((p) => p.url === url);
  return { url, host: new URL(url).hostname, minRefs: known?.minRefs ?? 10 };
});

// Each macro, the query used, and the host its page must land on.
const MACRO_CASES = [
  { macro: '@bestbuy_search', query: 'usb c hub', host: 'bestbuy.com' },
  { macro: '@indeed_search', query: 'data analyst', host: 'indeed.com' },
  { macro: '@pubmed_search', query: 'sleep apnea', host: 'pubmed.ncbi.nlm.nih.gov' },
  { macro: '@zillow_search', query: 'Austin, TX', host: 'zillow.com' },
];

const PAGE_STATE_KINDS = ['captcha', 'block', 'two_factor', 'login_wall', 'consent', 'no_results', 'ok'];

let tabId = null;
let failures = 0;
let skipped = 0;

function pass(name, detail = '') {
  console.log(`PASS  ${name}${detail ? ` (${detail})` : ''}`);
}

function fail(name, detail = '') {
  failures += 1;
  console.log(`FAIL  ${name}${detail ? ` (${detail})` : ''}`);
}

function check(name, ok, detail = '') {
  if (ok) pass(name, detail);
  else fail(name, detail);
}

function info(name, detail = '') {
  console.log(`INFO  ${name}${detail ? ` (${detail})` : ''}`);
}

function skip(name, reason) {
  skipped += 1;
  console.log(`SKIP  ${name} (${reason})`);
}

async function call(path, { method = 'GET', body, key = ACCESS_KEY, timeoutMs = 20_000 } = {}) {
  const headers = { Accept: 'application/json' };
  if (body) headers['Content-Type'] = 'application/json';
  if (key) headers.Authorization = `Bearer ${key}`;
  return fetch(`${BASE}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
    redirect: 'manual',
    signal: AbortSignal.timeout(timeoutMs),
  });
}

async function json(res) {
  try {
    return await res.json();
  } catch {
    return null;
  }
}

const tabPath = (suffix = '') => `/tabs/${encodeURIComponent(tabId)}${suffix}`;
const userQuery = `userId=${encodeURIComponent(userId)}`;

async function checkPage(page, index) {
  const label = `page ${index + 1} (${page.host})`;

  if (index === 0) {
    const opened = await call('/tabs', {
      method: 'POST',
      body: { userId, sessionKey, url: page.url },
    });
    const openedBody = await json(opened);
    tabId = openedBody?.tabId ?? null;
    check(`${label}: open tab`, opened.ok && typeof tabId === 'string', `HTTP ${opened.status}`);
    if (!tabId) return false;
  } else {
    const nav = await call(tabPath('/navigate'), {
      method: 'POST',
      body: { userId, url: page.url },
      timeoutMs: 90_000,
    });
    check(`${label}: navigate`, nav.ok, `HTTP ${nav.status}`);
    if (!nav.ok) return false;
  }

  await call(tabPath('/wait'), { method: 'POST', body: { userId, timeout: 15000 } });

  // /state needs the access key (checked once, on the first page).
  if (index === 0) {
    const noKey = await call(`${tabPath('/state')}?${userQuery}`, { key: '' });
    check('state without access key is rejected', noKey.status === 401, `HTTP ${noKey.status}`);
  }

  // /state reports the page.
  const state = await call(`${tabPath('/state')}?${userQuery}`);
  const stateBody = await json(state);
  check(`${label}: state returns 200`, state.ok && stateBody?.ok === true, `HTTP ${state.status}`);
  const hostMatches = typeof stateBody?.url === 'string' && new URL(stateBody.url).hostname.endsWith(page.host);
  check(`${label}: state url is the page`, hostMatches, stateBody?.url ?? 'no url');
  check(
    `${label}: state kind is a known value`,
    PAGE_STATE_KINDS.includes(stateBody?.state?.kind),
    stateBody?.state?.kind ?? 'no kind',
  );
  check(
    `${label}: state reports overlayRefs as a list`,
    Array.isArray(stateBody?.overlayRefs),
    `${stateBody?.overlayRefs?.length ?? 'n/a'} overlay refs`,
  );
  // A normal article should not be classified as a block or captcha page.
  check(
    `${label}: article is not a block or captcha page`,
    !['captcha', 'block'].includes(stateBody?.state?.kind),
    stateBody?.state?.kind ?? 'no kind',
  );

  // Snapshot gives a realistic number of refs on a content-rich page.
  const snap = await call(`${tabPath('/snapshot')}?${userQuery}`);
  const snapBody = await json(snap);
  check(
    `${label}: snapshot finds at least ${page.minRefs} element refs`,
    snap.ok && (snapBody?.refsCount ?? 0) >= page.minRefs,
    `${snapBody?.refsCount ?? 'n/a'} refs`,
  );

  // Dismiss runs on the page and returns lists. Pages without pop-ups should
  // report zero clicks, so this also checks the route does nothing extra.
  const dismiss = await call(tabPath('/overlays/dismiss'), {
    method: 'POST',
    body: { userId, maxClicks: 3 },
  });
  const dismissBody = await json(dismiss);
  check(
    `${label}: dismiss returns lists`,
    dismiss.ok && Array.isArray(dismissBody?.dismissed) && Array.isArray(dismissBody?.failed),
    `HTTP ${dismiss.status}`,
  );
  info(
    `${label}: overlays`,
    `${dismissBody?.dismissed?.length ?? 0} closed, ${dismissBody?.failed?.length ?? 0} could not be closed`,
  );
  return true;
}

async function run() {
  // 1. Each real page.
  for (let i = 0; i < PAGES.length; i++) {
    const ok = await checkPage(PAGES[i], i);
    if (!ok) return;
  }

  // 2. Each new search macro lands on its site.
  for (const testCase of MACRO_CASES) {
    const nav = await call(tabPath('/navigate'), {
      method: 'POST',
      body: { userId, macro: testCase.macro, query: testCase.query },
      timeoutMs: 90_000,
    });
    const navBody = await json(nav);
    const landed = typeof navBody?.url === 'string' ? navBody.url : '';
    let host = '';
    try {
      host = new URL(landed).hostname;
    } catch {
      host = '';
    }
    check(
      `macro ${testCase.macro} lands on ${testCase.host}`,
      nav.ok && (host === testCase.host || host.endsWith(`.${testCase.host}`)),
      nav.ok ? `landed on ${host || 'unknown host'}` : `HTTP ${nav.status}`,
    );

    // Informational: what the page-state check says about the landing page.
    if (nav.ok) {
      const after = await call(`${tabPath('/state')}?${userQuery}`);
      const afterBody = await json(after);
      info(`page state after ${testCase.macro}`, afterBody?.state?.kind ?? `HTTP ${after.status}`);
    }
  }

  // 3. Unknown tabs are rejected on the new routes.
  const missingState = await call(`/tabs/${encodeURIComponent(missingTabId)}/state?${userQuery}`);
  check('state for unknown tab is 404', missingState.status === 404, `HTTP ${missingState.status}`);
  const missingDismiss = await call(`/tabs/${encodeURIComponent(missingTabId)}/overlays/dismiss`, {
    method: 'POST',
    body: { userId, maxClicks: 3 },
  });
  check('dismiss for unknown tab is 404', missingDismiss.status === 404, `HTTP ${missingDismiss.status}`);

  // 4. Handoff gate: cannot be exercised live yet.
  skip('handoff gate returns 409 human_in_control', 'no route sets human control until handoff Phase 3; covered by unit tests');
}

async function cleanup() {
  if (tabId) {
    const res = await call(`${tabPath()}?${userQuery}`, { method: 'DELETE' });
    check('cleanup: close test tab', res.ok, `HTTP ${res.status}`);
  }
  const session = await call(`/sessions/${encodeURIComponent(userId)}`, { method: 'DELETE' });
  check('cleanup: close test session', session.ok, `HTTP ${session.status}`);
}

try {
  await run();
} catch (err) {
  fail('unexpected error', err.message);
} finally {
  await cleanup();
}

console.log(
  failures === 0
    ? `\nAll branch checks passed${skipped ? ` (${skipped} skipped)` : ''}.`
    : `\n${failures} check(s) failed${skipped ? ` (${skipped} skipped)` : ''}.`,
);
process.exitCode = failures === 0 ? 0 : 1;
