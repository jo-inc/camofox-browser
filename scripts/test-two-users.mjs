/**
 * Two-user isolation test against a running Camofox server.
 *
 * Usage: node scripts/test-two-users.mjs   (reads .env)
 *
 * Checks that user B cannot see, hand off, or view user A's tab, and that A's
 * handoff does not block B's tab. Each run uses fresh random user IDs and
 * cleans up after itself.
 */
import { randomUUID } from 'node:crypto';
import { call, makeReporter } from './lib-env.mjs';

const report = makeReporter();
const a = `two-users-a-${randomUUID()}`;
const b = `two-users-b-${randomUUID()}`;
const tabs = { a: null, b: null };

async function openTab(userId, url) {
  const res = await call('/tabs', { method: 'POST', body: { userId, sessionKey: `s-${randomUUID()}`, url } });
  return res.data?.tabId ?? null;
}

try {
  tabs.a = await openTab(a, 'https://example.com/');
  tabs.b = await openTab(b, 'https://example.org/');
  report.check('both users open a tab', !!tabs.a && !!tabs.b);
  if (!tabs.a || !tabs.b) throw new Error('could not open tabs');

  // B cannot read A's tab.
  const bReadsA = await call(`/tabs/${tabs.a}/state?userId=${encodeURIComponent(b)}`);
  report.check('B cannot read A tab state', bReadsA.status === 404, `HTTP ${bReadsA.status}`);

  // B cannot start a handoff on A's tab.
  const bHandsA = await call(`/tabs/${tabs.a}/handoff`, { method: 'POST', body: { userId: b, reason: 'x' } });
  report.check('B cannot start a handoff on A tab', bHandsA.status === 404, `HTTP ${bHandsA.status}`);

  // B cannot read A's control state.
  const bControlA = await call(`/tabs/${tabs.a}/control?userId=${encodeURIComponent(b)}`);
  report.check('B cannot read A control state', bControlA.status === 404, `HTTP ${bControlA.status}`);

  // B cannot get a viewer link for A's tab.
  const bLinkA = await call('/live-viewer/links', { method: 'POST', body: { userId: b, tabId: tabs.a } });
  report.check('B cannot get a viewer link for A tab', bLinkA.status === 404, `HTTP ${bLinkA.status}`);

  // A starts a handoff on A's tab.
  const aHand = await call(`/tabs/${tabs.a}/handoff`, { method: 'POST', body: { userId: a, reason: 'two-user test', idleMs: 60000 } });
  report.check('A starts a handoff on own tab', aHand.status === 200, `HTTP ${aHand.status}`);

  // A's handoff must not block B's tab.
  const bScroll = await call(`/tabs/${tabs.b}/scroll`, { method: 'POST', body: { userId: b, direction: 'down', amount: 100 } });
  report.check("A's handoff does not block B's tab", bScroll.status === 200, `HTTP ${bScroll.status}`);

  // B cannot start a control link on A's tab even while A is handed off.
  const bControlLinkA = await call('/live-viewer/links', { method: 'POST', body: { userId: b, tabId: tabs.a, control: true } });
  report.check('B cannot get a control link for A tab during A handoff', bControlLinkA.status === 404, `HTTP ${bControlLinkA.status}`);

  // B's own tab has no handoff, so a control link for it is refused.
  const bControlLinkB = await call('/live-viewer/links', { method: 'POST', body: { userId: b, tabId: tabs.b, control: true } });
  report.check("B's control link refused when B has no handoff", bControlLinkB.status === 409, `HTTP ${bControlLinkB.status}`);

  // A's control link works for A.
  const aControlLink = await call('/live-viewer/links', { method: 'POST', body: { userId: a, tabId: tabs.a, control: true } });
  report.check('A gets a control link for own tab', aControlLink.status === 200 && !!aControlLink.data?.url, `HTTP ${aControlLink.status}`);
} catch (err) {
  report.check('unexpected error', false, err.message);
} finally {
  for (const [who, userId] of [['a', a], ['b', b]]) {
    if (tabs[who]) {
      await call(`/tabs/${tabs[who]}/handoff/release`, { method: 'POST', body: { userId } });
      await call(`/tabs/${tabs[who]}?userId=${encodeURIComponent(userId)}`, { method: 'DELETE' });
    }
    await call(`/sessions/${encodeURIComponent(userId)}`, { method: 'DELETE' });
  }
  report.finish();
}
