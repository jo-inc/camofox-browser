/**
 * Checks the page-side extraction (collectPageData + buildExtraction) in a real
 * browser, against a fixture page with known contents. Needs Chromium through
 * Playwright, but no Camofox server and no access key.
 *
 * Usage: node scripts/test-extract-page.mjs
 */
import { createRequire } from 'node:module';
import { collectPageData, buildExtraction } from '../lib/extract.js';

const require = createRequire(import.meta.url);
let chromium;
try {
  ({ chromium } = require('playwright'));
} catch {
  console.error('Playwright is not installed here. Run: npm i -D playwright && npx playwright install chromium');
  process.exit(2);
}

const FIXTURE = `<!doctype html><html><head><title>Fixture shop</title>
<script type="application/ld+json">{"@context":"https://schema.org","@type":"Product","name":"USB-C Hub","offers":{"@type":"Offer","price":"24.99","priceCurrency":"USD"}}</script>
<script type="application/ld+json">{ this is broken json</script>
</head><body>
<table>
  <tr><th>Model</th><th>Price</th></tr>
  <tr><td>Hub A</td><td>$24.99</td></tr>
  <tr><td>Hub B</td><td>£45</td></tr>
</table>
<div class="card"><a href="/p/1">USB-C Multiport Adapter 5-in-1</a><span>Now $19.99</span></div>
<div class="card"><a href="/p/2">HDMI 4K Display Adapter</a><span>€12.50</span></div>
<div class="card"><a href="/p/1">USB-C Multiport Adapter 5-in-1 (duplicate)</a><span>$19.99</span></div>
<p style="display:none">Hidden price $999.00</p>
<a href="/short">Hi</a>
</body></html>`;

const checks = [];
const check = (name, ok, detail = '') => {
  checks.push(ok);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` (${detail})` : ''}`);
};

const browser = await chromium.launch();
try {
  const page = await browser.newPage();
  await page.setContent(FIXTURE, { waitUntil: 'load' });
  const raw = await page.evaluate(collectPageData);
  const data = buildExtraction(raw);

  check('title and url are read', data.title === 'Fixture shop' && typeof data.url === 'string');

  check('one table with headers Model and Price', data.tables.length === 1
    && JSON.stringify(data.tables[0].headers) === JSON.stringify(['Model', 'Price']), JSON.stringify(data.tables[0]?.headers));
  check('table rows are read', data.tables[0]?.rows.length === 2 && data.tables[0].rows[1][1] === '£45');

  const amounts = data.prices.map((p) => `${p.currency} ${p.amount}`);
  check('prices include USD 24.99, GBP 45, USD 19.99, EUR 12.5', ['USD 24.99', 'GBP 45', 'USD 19.99', 'EUR 12.5'].every((a) => amounts.includes(a)), amounts.join(', '));
  check('hidden price is excluded', !data.prices.some((p) => p.amount === 999));

  check('JSON-LD Product is parsed', data.json_ld.items.some((i) => i['@type'] === 'Product' && i.name === 'USB-C Hub'));
  check('broken JSON-LD is skipped and counted', data.json_ld.skipped === 1, `skipped=${data.json_ld.skipped}`);

  const urls = data.listings.map((l) => l.url);
  check('listings found with price', data.listings.length === 2 && data.listings.every((l) => l.price), JSON.stringify(data.listings.map((l) => [l.title, l.price?.amount])));
  check('duplicate listing URL is kept once', new Set(urls).size === urls.length);
  check('too-short link title is skipped', !data.listings.some((l) => l.title === 'Hi'));

  const onlyPrices = buildExtraction(raw, ['prices']);
  check('kinds filter returns only prices', onlyPrices.prices && !onlyPrices.tables && !onlyPrices.listings);
} catch (err) {
  check('unexpected error', false, err.message);
} finally {
  await browser.close();
}

const failed = checks.filter((ok) => !ok).length;
console.log(failed === 0 ? `\nAll ${checks.length} page extraction checks passed.` : `\n${failed} of ${checks.length} check(s) failed.`);
process.exitCode = failed === 0 ? 0 : 1;
