/**
 * Live check of POST /tabs/{tabId}/extract against a running Camofox server.
 *
 * Usage: node scripts/test-extract-live.mjs   (reads .env)
 *
 * Checks the response shape in kinds mode, the 400 errors, and the handoff lock (409).
 */
import { randomUUID } from 'node:crypto';
import { call, makeReporter } from './lib-env.mjs';

const report = makeReporter();
const userId = `extract-live-${randomUUID()}`;
let tabId = null;

try {
  const opened = await call('/tabs', { method: 'POST', body: { userId, sessionKey: `s-${randomUUID()}`, url: 'https://example.com/' }, timeoutMs: 60_000 });
  tabId = opened.data?.tabId ?? null;
  report.check('open tab', !!tabId, `HTTP ${opened.status}`);
  if (!tabId) throw new Error('no tab');

  const ex = `/tabs/${tabId}/extract`;
  const kinds = await call(ex, { method: 'POST', body: { userId } });
  const d = kinds.data || {};
  report.check('kinds mode returns ok with all parts', kinds.status === 200 && d.ok === true
    && Array.isArray(d.tables) && Array.isArray(d.prices) && Array.isArray(d.listings) && typeof d.json_ld === 'object',
    `HTTP ${kinds.status}`);

  const one = await call(ex, { method: 'POST', body: { userId, kinds: ['prices'] } });
  report.check('kinds filter returns only prices', one.status === 200 && one.data?.prices && one.data?.tables === undefined, `HTTP ${one.status}`);

  const both = await call(ex, { method: 'POST', body: { userId, kinds: ['prices'], schema: { type: 'object', properties: {} } } });
  report.check('schema and kinds together are refused', both.status === 400, `HTTP ${both.status}`);

  const badKind = await call(ex, { method: 'POST', body: { userId, kinds: ['everything'] } });
  report.check('unknown kind is refused', badKind.status === 400, `HTTP ${badKind.status}`);

  const noUser = await call(ex, { method: 'POST', body: {} });
  report.check('missing userId is refused', noUser.status === 400, `HTTP ${noUser.status}`);

  const start = await call(`/tabs/${tabId}/handoff`, { method: 'POST', body: { userId, reason: 'extract live test', idleMs: 60000 } });
  report.check('start handoff', start.status === 200, `HTTP ${start.status}`);
  const locked = await call(ex, { method: 'POST', body: { userId } });
  report.check('extract refused while a person holds the tab', locked.status === 409 && locked.data?.error === 'human_in_control', `HTTP ${locked.status}`);
} catch (err) {
  report.check('unexpected error', false, err.message);
} finally {
  if (tabId) {
    await call(`/tabs/${tabId}/handoff/release`, { method: 'POST', body: { userId } });
    await call(`/tabs/${tabId}?userId=${encodeURIComponent(userId)}`, { method: 'DELETE' });
  }
  await call(`/sessions/${encodeURIComponent(userId)}`, { method: 'DELETE' });
  report.finish();
}
