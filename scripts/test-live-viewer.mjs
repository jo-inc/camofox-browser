/**
 * Test the live viewer end to end against a running Camofox server.
 *
 * Usage (reads CAMOFOX_BASE_URL and CAMOFOX_ACCESS_KEY from the environment or .env):
 *   node scripts/test-live-viewer.mjs
 *
 * Checks:
 *   - POST /live-viewer/links without a key is rejected (401)
 *   - POST /live-viewer/links with the key issues a link for an open tab
 *   - the viewer page loads WITHOUT the access key
 *   - the frame endpoint returns a PNG with the signed token, WITHOUT the access key
 *   - a tampered token is rejected (401)
 *   - a link for a tab that does not exist is rejected (404)
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

const userId = `live-viewer-test-${randomUUID()}`;
const sessionKey = `live-viewer-${randomUUID()}`;
let tabId = null;
let failures = 0;

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

async function call(path, { method = 'GET', body, key = ACCESS_KEY } = {}) {
  const headers = { Accept: '*/*' };
  if (body) headers['Content-Type'] = 'application/json';
  if (key) headers.Authorization = `Bearer ${key}`;
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
    redirect: 'manual',
    signal: AbortSignal.timeout(20_000),
  });
  return res;
}

async function json(res) {
  try {
    return await res.json();
  } catch {
    return null;
  }
}

async function run() {
  // 1. Open a tab to watch.
  const opened = await call('/tabs', {
    method: 'POST',
    body: { userId, sessionKey, url: 'https://example.com/' },
  });
  const openedBody = await json(opened);
  tabId = openedBody?.tabId ?? null;
  check('open test tab', opened.ok && typeof tabId === 'string', `HTTP ${opened.status}`);
  if (!tabId) return;

  // 2. Issuing a link needs the access key.
  const noKey = await call('/live-viewer/links', {
    method: 'POST',
    key: '',
    body: { userId, tabId },
  });
  check('issue link without key is rejected', noKey.status === 401, `HTTP ${noKey.status}`);

  // 3. Issue a link with the key.
  const issued = await call('/live-viewer/links', {
    method: 'POST',
    body: { userId, tabId, ttlSeconds: 120 },
  });
  const issuedBody = await json(issued);
  check('issue link with key', issued.ok && typeof issuedBody?.url === 'string', `HTTP ${issued.status}`);
  if (!issuedBody?.url) return;

  const viewerUrl = new URL(issuedBody.url);
  const token = viewerUrl.searchParams.get('t');
  check('link carries a token', typeof token === 'string' && token.includes('.'));
  if (!token) return;

  // 4. The viewer page loads without the access key.
  const view = await fetch(viewerUrl, { headers: { Accept: 'text/html' }, redirect: 'manual' });
  const html = await view.text();
  check(
    'viewer page loads without access key',
    view.status === 200 && html.includes('Live view'),
    `HTTP ${view.status}`,
  );

  // 5. The frame endpoint returns a PNG for the token, without the access key.
  const frame = await call(`/live-viewer/frame?t=${encodeURIComponent(token)}`, { key: '' });
  const frameBytes = frame.ok ? Buffer.from(await frame.arrayBuffer()) : Buffer.alloc(0);
  const isPng = frameBytes.length > 8 && frameBytes.subarray(0, 4).toString('hex') === '89504e47';
  check(
    'frame returns a PNG without access key',
    frame.ok && isPng && (frame.headers.get('content-type') || '').includes('image/png'),
    `HTTP ${frame.status}, ${frameBytes.length} bytes`,
  );

  // 6. A tampered token is rejected.
  const tampered = token.slice(0, -2) + (token.endsWith('AA') ? 'BB' : 'AA');
  const bad = await call(`/live-viewer/frame?t=${encodeURIComponent(tampered)}`, { key: '' });
  check('tampered token is rejected', bad.status === 401, `HTTP ${bad.status}`);

  // 7. A link for a missing tab is rejected.
  const missing = await call('/live-viewer/links', {
    method: 'POST',
    body: { userId, tabId: randomUUID() },
  });
  check('link for missing tab is rejected', missing.status === 404, `HTTP ${missing.status}`);
}

async function cleanup() {
  if (tabId) {
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
  fail('unexpected error', err.message);
} finally {
  await cleanup();
}

console.log(failures === 0 ? '\nAll live-viewer checks passed.' : `\n${failures} check(s) failed.`);
process.exitCode = failures === 0 ? 0 : 1;
