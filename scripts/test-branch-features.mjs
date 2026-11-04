/**
 * Test the features added on feature/browser-experience against a running
 * Camofox server.
 *
 * Usage (reads CAMOFOX_BASE_URL and CAMOFOX_ACCESS_KEY from the environment or .env):
 *   node scripts/test-branch-features.mjs
 *
 * Checks:
 *   - GET /tabs/:tabId/state without a key is rejected (401)
 *   - GET /tabs/:tabId/state reports a page state and overlay refs
 *   - POST /tabs/:tabId/overlays/dismiss runs and returns dismissed/failed lists
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

async function run() {
  // 1. Open a tab on a stable page.
  const opened = await call('/tabs', {
    method: 'POST',
    body: { userId, sessionKey, url: 'https://example.com/' },
  });
  const openedBody = await json(opened);
  tabId = openedBody?.tabId ?? null;
  check('open test tab', opened.ok && typeof tabId === 'string', `HTTP ${opened.status}`);
  if (!tabId) return;

  // Let the page finish loading before checking its state.
  await call(`/tabs/${encodeURIComponent(tabId)}/wait`, {
    method: 'POST',
    body: { userId, timeout: 10000 },
  });

  // 2. /state needs the access key.
  const noKey = await call(`/tabs/${encodeURIComponent(tabId)}/state?userId=${encodeURIComponent(userId)}`, { key: '' });
  check('state without access key is rejected', noKey.status === 401, `HTTP ${noKey.status}`);

  // 3. /state reports the page state.
  const state = await call(`/tabs/${encodeURIComponent(tabId)}/state?userId=${encodeURIComponent(userId)}`);
  const stateBody = await json(state);
  check('state returns 200 with a body', state.ok && stateBody?.ok === true, `HTTP ${state.status}`);
  check(
    'state url is example.com',
    typeof stateBody?.url === 'string' && stateBody.url.includes('example.com'),
    stateBody?.url ?? 'no url',
  );
  check(
    'state kind is a known value',
    PAGE_STATE_KINDS.includes(stateBody?.state?.kind),
    stateBody?.state?.kind ?? 'no kind',
  );
  check(
    'state reports overlayRefs as a list',
    Array.isArray(stateBody?.overlayRefs),
    `${stateBody?.overlayRefs?.length ?? 'n/a'} refs`,
  );

  // 4. Dismiss overlays after a snapshot so refs are current.
  await call(`/tabs/${encodeURIComponent(tabId)}/snapshot?userId=${encodeURIComponent(userId)}`);
  const dismiss = await call(`/tabs/${encodeURIComponent(tabId)}/overlays/dismiss`, {
    method: 'POST',
    body: { userId, maxClicks: 3 },
  });
  const dismissBody = await json(dismiss);
  check('dismiss returns 200 with lists', dismiss.ok && Array.isArray(dismissBody?.dismissed) && Array.isArray(dismissBody?.failed), `HTTP ${dismiss.status}`);
  check('dismiss on example.com leaves the page open', dismiss.ok, `${dismissBody?.dismissed?.length ?? 0} closed, ${dismissBody?.failed?.length ?? 0} failed`);

  // 5. Each new macro lands on its site.
  for (const testCase of MACRO_CASES) {
    const nav = await call(`/tabs/${encodeURIComponent(tabId)}/navigate`, {
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
      const after = await call(`/tabs/${encodeURIComponent(tabId)}/state?userId=${encodeURIComponent(userId)}`);
      const afterBody = await json(after);
      info(`page state after ${testCase.macro}`, afterBody?.state?.kind ?? `HTTP ${after.status}`);
    }
  }

  // 6. Unknown tabs are rejected on the new routes.
  const missingState = await call(`/tabs/${encodeURIComponent(missingTabId)}/state?userId=${encodeURIComponent(userId)}`);
  check('state for unknown tab is 404', missingState.status === 404, `HTTP ${missingState.status}`);
  const missingDismiss = await call(`/tabs/${encodeURIComponent(missingTabId)}/overlays/dismiss`, {
    method: 'POST',
    body: { userId, maxClicks: 3 },
  });
  check('dismiss for unknown tab is 404', missingDismiss.status === 404, `HTTP ${missingDismiss.status}`);

  // 7. Handoff gate: cannot be exercised live yet.
  skip('handoff gate returns 409 human_in_control', 'no route sets human control until handoff Phase 3; covered by unit tests');
}

async function cleanup() {
  if (tabId) {
    const res = await call(`/tabs/${encodeURIComponent(tabId)}?userId=${encodeURIComponent(userId)}`, { method: 'DELETE' });
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
