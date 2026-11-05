/**
 * Live site checks against a running Camofox server.
 *
 * Usage: node scripts/test-live-sites.mjs            (all sites)
 *        node scripts/test-live-sites.mjs hn maps     (only the named sites)
 *
 * For each site: open a tab, wait, read the page state, and check the title
 * matches what we expect. A site that shows a consent, captcha or sign-in page
 * is reported as such, not as a pass. Sites are JS-rendered or heavily guarded,
 * so a FAIL here is information, not necessarily a server bug.
 */
import { randomUUID } from 'node:crypto';
import { call, makeReporter } from './lib-env.mjs';

const SITES = [
  { id: 'hn', name: 'Hacker News (Algolia search)', url: 'https://hn.algolia.com/?q=camofox', title: /hacker news|algolia/i, allowKinds: ['ok'] },
  { id: 'maps', name: 'Google Maps', url: 'https://www.google.com/maps/search/coffee+london', title: /maps|coffee/i, allowKinds: ['ok', 'consent'] },
  { id: 'ia', name: 'Internet Archive', url: 'https://archive.org/details/texts', title: /internet archive|texts/i, allowKinds: ['ok'] },
  { id: 'ch', name: 'Companies House (company search)', url: 'https://find-and-update.company-information.service.gov.uk/search/companies?q=tesco', title: /tesco|companies house/i, allowKinds: ['ok'] },
  { id: 'edgar', name: 'SEC EDGAR (Apple 10-K search)', url: 'https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=0000320193&type=10-K', title: /apple|edgar/i, allowKinds: ['ok'] },
];

const wanted = process.argv.slice(2);
const sites = wanted.length ? SITES.filter((s) => wanted.includes(s.id)) : SITES;
const report = makeReporter();

for (const site of sites) {
  const userId = `live-sites-${randomUUID()}`;
  let tabId = null;
  try {
    const opened = await call('/tabs', { method: 'POST', body: { userId, sessionKey: `s-${randomUUID()}`, url: site.url }, timeoutMs: 60_000 });
    tabId = opened.data?.tabId ?? null;
    if (!tabId) {
      report.check(`${site.name}: open tab`, false, `HTTP ${opened.status}`);
      continue;
    }
    // Give client-side rendering a moment before reading the state.
    await new Promise((r) => setTimeout(r, 4000));
    const state = await call(`/tabs/${tabId}/state?userId=${encodeURIComponent(userId)}`);
    const kind = state.data?.state?.kind ?? 'unknown';
    const title = state.data?.title ?? '';
    const titleOk = site.title.test(title);
    const kindOk = site.allowKinds.includes(kind);
    report.check(
      `${site.name}: page loads and title matches`,
      state.status === 200 && titleOk && kindOk,
      `kind=${kind}, title="${title.slice(0, 80)}"`,
    );
  } catch (err) {
    report.check(`${site.name}: unexpected error`, false, err.message);
  } finally {
    if (tabId) await call(`/tabs/${tabId}?userId=${encodeURIComponent(userId)}`, { method: 'DELETE' });
    await call(`/sessions/${encodeURIComponent(userId)}`, { method: 'DELETE' });
  }
}
report.finish();
