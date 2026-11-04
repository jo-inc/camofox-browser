/**
 * Test the handoff flow end to end against a running Camofox server.
 *
 * Usage (reads CAMOFOX_BASE_URL and CAMOFOX_ACCESS_KEY from the environment or .env):
 *   node scripts/test-handoff-live.mjs
 *
 * Checks:
 *   - handoff routes need the access key (401 without it)
 *   - a control link is refused while the agent holds the tab (409)
 *   - a handoff starts, the agent is blocked (409 human_in_control) and the state reads back
 *   - a control link works during the handoff; a view-only link cannot act
 *   - a person's click, key and scroll inputs are accepted; invalid input is rejected (400)
 *   - Done returns the tab to the agent, and the agent can act again
 *   - a link from an earlier handoff cannot act on a later one
 *   - the tab is released on exit, even when a check fails
 *
 * Typed text is sent but never printed.
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

const userId = `handoff-test-${randomUUID()}`;
const sessionKey = `handoff-${randomUUID()}`;
let tabId = null;
let failures = 0;

function check(name, ok, detail = '') {
  if (ok) console.log(`PASS  ${name}${detail ? ` (${detail})` : ''}`);
  else {
    failures += 1;
    console.log(`FAIL  ${name}${detail ? ` (${detail})` : ''}`);
  }
}

async function call(path, { method = 'GET', body, key = ACCESS_KEY } = {}) {
  const headers = { Accept: 'application/json' };
  if (body) headers['Content-Type'] = 'application/json';
  if (key) headers.Authorization = `Bearer ${key}`;
  return fetch(`${BASE}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
    redirect: 'manual',
    signal: AbortSignal.timeout(20_000),
  });
}

async function json(res) {
  try {
    return await res.json();
  } catch {
    return null;
  }
}

async function issueLink(body) {
  const res = await call('/live-viewer/links', { method: 'POST', body: { userId, tabId, ttlSeconds: 300, ...body } });
  const data = await json(res);
  const token = data?.url ? new URL(data.url).searchParams.get('t') : null;
  return { status: res.status, token };
}

async function liveControl(token) {
  const res = await call(`/live-viewer/control?t=${encodeURIComponent(token)}`, { key: '' });
  return { status: res.status, data: await json(res) };
}

async function viewerPost(path, token, body) {
  const res = await call(`${path}?t=${encodeURIComponent(token)}`, {
    method: 'POST',
    body: body ?? {},
    key: '',
  });
  return { status: res.status, data: await json(res) };
}

async function agentScroll() {
  const res = await call(`/tabs/${encodeURIComponent(tabId)}/scroll`, {
    method: 'POST',
    body: { userId, direction: 'down', amount: 100 },
  });
  return { status: res.status, data: await json(res) };
}

async function startHandoff(reason) {
  const res = await call(`/tabs/${encodeURIComponent(tabId)}/handoff`, {
    method: 'POST',
    body: { userId, reason, idleMs: 60_000 },
  });
  return { status: res.status, data: await json(res) };
}

async function run() {
  const opened = await call('/tabs', { method: 'POST', body: { userId, sessionKey, url: 'https://example.com/' } });
  const openedBody = await json(opened);
  tabId = openedBody?.tabId ?? null;
  check('open test tab', opened.ok && typeof tabId === 'string', `HTTP ${opened.status}`);
  if (!tabId) return;

  // Handoff routes need the access key.
  const noKey = await call(`/tabs/${encodeURIComponent(tabId)}/handoff`, {
    method: 'POST',
    body: { userId },
    key: '',
  });
  check('handoff without access key is rejected', noKey.status === 401, `HTTP ${noKey.status}`);

  // The agent holds the tab, so no control link can be issued yet.
  const early = await issueLink({ control: true });
  check('control link refused while agent holds tab', early.status === 409, `HTTP ${early.status}`);

  // Start a handoff.
  const started = await startHandoff('live test: please log in');
  check('handoff starts', started.status === 200 && started.data?.mode === 'human', `HTTP ${started.status}`);

  const control = await call(`/tabs/${encodeURIComponent(tabId)}/control?userId=${encodeURIComponent(userId)}`);
  const controlBody = await json(control);
  check('control state reads human', controlBody?.mode === 'human', `HTTP ${control.status}`);

  // The agent is blocked while a person holds the tab.
  const blocked = await agentScroll();
  check(
    'agent action blocked during handoff',
    blocked.status === 409 && blocked.data?.error === 'human_in_control',
    `HTTP ${blocked.status}`,
  );

  // Control link and view-only link.
  const controlLink = await issueLink({ control: true });
  check('control link issued during handoff', controlLink.status === 200 && !!controlLink.token, `HTTP ${controlLink.status}`);
  const viewLink = await issueLink({});
  check('view-only link issued', viewLink.status === 200 && !!viewLink.token, `HTTP ${viewLink.status}`);
  if (!controlLink.token || !viewLink.token) return;

  const cState = await liveControl(controlLink.token);
  check(
    'control link reports it can control and a handoff is active',
    cState.data?.canControl === true && cState.data?.handoff !== null,
    `HTTP ${cState.status}`,
  );
  const vState = await liveControl(viewLink.token);
  check('view-only link cannot control', vState.data?.canControl === false, `HTTP ${vState.status}`);

  // A view-only link cannot send input or press Done.
  const viewInput = await viewerPost('/live-viewer/input', viewLink.token, { action: 'click', x: 0.5, y: 0.5 });
  check('view-only link input refused', viewInput.status === 409, `HTTP ${viewInput.status}`);
  const viewDone = await viewerPost('/live-viewer/done', viewLink.token);
  check('view-only link cannot press Done', viewDone.status === 403, `HTTP ${viewDone.status}`);

  // Invalid input is rejected before it reaches the page.
  const badInput = await viewerPost('/live-viewer/input', controlLink.token, { action: 'click', x: 2, y: 0.5 });
  check('out-of-range click rejected', badInput.status === 400, `HTTP ${badInput.status}`);
  const badKey = await viewerPost('/live-viewer/input', controlLink.token, { action: 'key', key: 'F12' });
  check('disallowed key rejected', badKey.status === 400, `HTTP ${badKey.status}`);

  // Valid input from the person.
  const click = await viewerPost('/live-viewer/input', controlLink.token, { action: 'click', x: 0.5, y: 0.5 });
  check('person click accepted', click.status === 200 && click.data?.ok === true, `HTTP ${click.status}`);
  const typed = await viewerPost('/live-viewer/input', controlLink.token, { action: 'type', text: 'test entry' });
  check('person typing accepted', typed.status === 200, `HTTP ${typed.status}`);
  const key = await viewerPost('/live-viewer/input', controlLink.token, { action: 'key', key: 'Tab' });
  check('person key press accepted', key.status === 200, `HTTP ${key.status}`);
  const scroll = await viewerPost('/live-viewer/input', controlLink.token, { action: 'scroll', deltaY: 200 });
  check('person scroll accepted', scroll.status === 200, `HTTP ${scroll.status}`);

  // Done returns the tab to the agent.
  const done = await viewerPost('/live-viewer/done', controlLink.token);
  check('Done returns tab to agent', done.status === 200 && done.data?.status === 'agent', `HTTP ${done.status}`);
  const after = await agentScroll();
  check('agent can act again after Done', after.status === 200, `HTTP ${after.status}`);

  // The control link is dead once the handoff has ended.
  const stale = await viewerPost('/live-viewer/input', controlLink.token, { action: 'click', x: 0.5, y: 0.5 });
  check('control link refused after Done', stale.status === 409, `HTTP ${stale.status}`);

  // A new handoff must not revive the old link.
  const second = await startHandoff('live test: second handoff');
  check('second handoff starts', second.status === 200, `HTTP ${second.status}`);
  const oldLink = await viewerPost('/live-viewer/input', controlLink.token, { action: 'click', x: 0.5, y: 0.5 });
  check('old control link cannot act on new handoff', oldLink.status === 409, `HTTP ${oldLink.status}`);
  const oldDone = await viewerPost('/live-viewer/done', controlLink.token);
  check('old link Done does not end new handoff', oldDone.status === 200, `HTTP ${oldDone.status}`);
  const stillBlocked = await agentScroll();
  check('new handoff still blocks agent after old link Done', stillBlocked.status === 409, `HTTP ${stillBlocked.status}`);

  const release = await call(`/tabs/${encodeURIComponent(tabId)}/handoff/release`, {
    method: 'POST',
    body: { userId },
  });
  check('agent release returns tab', release.status === 200, `HTTP ${release.status}`);
}

async function cleanup() {
  if (tabId) {
    await call(`/tabs/${encodeURIComponent(tabId)}/handoff/release`, { method: 'POST', body: { userId } });
    const res = await call(`/tabs/${encodeURIComponent(tabId)}?userId=${encodeURIComponent(userId)}`, {
      method: 'DELETE',
    });
    check('cleanup: close test tab', res.ok, `HTTP ${res.status}`);
  }
  const session = await call(`/sessions/${encodeURIComponent(userId)}`, { method: 'DELETE' });
  check('cleanup: close test session', session.ok, `HTTP ${session.status}`);
}

try {
  await run();
} catch (err) {
  check('unexpected error', false, err.message);
} finally {
  await cleanup();
}

console.log(failures === 0 ? '\nAll handoff checks passed.' : `\n${failures} check(s) failed.`);
process.exitCode = failures === 0 ? 0 : 1;
