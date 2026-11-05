#!/usr/bin/env node
// Verifies a Camofox server end to end: health, key, open, state, read, extract, close.
// Uses a throwaway userId, so it never touches a real user's tabs.
//   node scripts/check-server.mjs [--url https://example.com]
import { loadDotEnv, reporter } from './lib-env.mjs';
import { CamofoxClient } from './camofox-client.mjs';

const env = { ...loadDotEnv(), ...process.env };
const args = process.argv.slice(2);
const target = args.includes('--url') ? args[args.indexOf('--url') + 1] : 'https://example.com';
const r = reporter();

const baseUrl = env.CAMOFOX_BASE_URL;
const accessKey = env.CAMOFOX_ACCESS_KEY;
if (!baseUrl || !accessKey) {
  r.fail('config', 'CAMOFOX_BASE_URL and CAMOFOX_ACCESS_KEY must be set (run setup-env.mjs)');
  r.done(); process.exit(1);
}

const check = async (name, fn) => {
  try { const detail = await fn(); r.pass(name, detail || ''); return true; }
  catch (e) { r.fail(name, e.message.slice(0, 200)); return false; }
};

const probe = new CamofoxClient({ baseUrl, accessKey, userId: 'setup-check' });
let tabId;

await check('health reachable without key', async () => {
  const res = await fetch(baseUrl.replace(/\/+$/, '') + '/health', { signal: AbortSignal.timeout(15000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return `HTTP ${res.status}`;
});

await check('key accepted (open a tab)', async () => {
  const out = await probe.openTab({ url: target, sessionKey: 'setup-check' });
  tabId = out.tabId;
  if (!tabId) throw new Error('no tabId in response');
  return `tab ${String(tabId).slice(0, 8)}…`;
});

if (tabId) {
  await check('read page state', async () => {
    const out = await probe.state(tabId);
    const kind = out?.state?.kind ?? out?.kind;
    if (!kind) throw new Error('no state.kind in response');
    return `kind=${kind}`;
  });

  await check('snapshot has refs', async () => {
    const out = await probe.snapshot(tabId);
    const text = typeof out === 'string' ? out : JSON.stringify(out);
    if (!text || text.length < 10) throw new Error('empty snapshot');
    return `${text.length} chars`;
  });

  await check('extract tables/prices/json_ld/listings', async () => {
    const out = await probe.extract(tabId, { kinds: ['tables', 'prices', 'json_ld', 'listings'] });
    if (!out || typeof out !== 'object') throw new Error('no JSON result');
    return Object.keys(out).join(', ');
  });

  await check('close tab', async () => {
    await probe.closeTab(tabId);
    return 'closed';
  });
}

await check('end setup session', async () => { await probe.endSession(); return 'ok'; });

await check('wrong key is refused (401)', async () => {
  const bad = new CamofoxClient({ baseUrl, accessKey: accessKey + 'x', userId: 'setup-check' });
  try { await bad.openTab({ url: target, sessionKey: 'setup-check' }); }
  catch (e) { if (e.status === 401) return 'refused as expected'; throw e; }
  throw new Error('a wrong key was accepted');
});

r.done();
