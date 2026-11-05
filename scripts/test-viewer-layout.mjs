import http from 'node:http';
import { readFileSync } from 'node:fs';
// Usage: node scripts/test-viewer-layout.mjs  (needs the playwright package and a Chromium it can launch)
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { chromium } = require('playwright');

const VIEWER = new URL('../plugins/live-viewer/viewer.html', import.meta.url);
const html = readFileSync(VIEWER, 'utf8');

// Build a realistic frame: a 1280x800 page screenshot.
const browser = await chromium.launch();
const shotPage = await browser.newPage({ viewport: { width: 1280, height: 800 } });
await shotPage.setContent(`<body style="margin:0;font:16px sans-serif">
  <div style="background:#1e40af;color:#fff;height:56px;display:flex;align-items:center;padding:0 24px">Best Buy (test frame)</div>
  <div style="padding:24px"><h2>Search results: usb c hub</h2>
  ${Array.from({length: 12}, (_, i) => `<div style="border:1px solid #ddd;margin:8px 0;padding:12px">Product ${i+1}</div>`).join('')}</div></body>`);
const frameBuf = await shotPage.screenshot({ type: 'png' });
await browser.close().then(() => {});

let handoff = null;
const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname === '/live-viewer/view') { res.writeHead(200, {'content-type':'text/html'}); return res.end(html); }
  if (url.pathname === '/live-viewer/frame') { res.writeHead(200, {'content-type':'image/png'}); return res.end(frameBuf); }
  if (url.pathname === '/live-viewer/control') {
    res.writeHead(200, {'content-type':'application/json'});
    return res.end(JSON.stringify({ canControl: true, handoff: handoff ? { until: new Date(Date.now()+600000).toISOString(), reason: 'Sign in' } : null }));
  }
  if (url.pathname === '/__handoff') { handoff = url.searchParams.get('on') === '1' ? true : null; res.end('ok'); return; }
  res.writeHead(404); res.end();
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;

const b = await chromium.launch();
const results = [];
const check = (name, ok, detail='') => results.push([ok ? 'PASS' : 'FAIL', name, detail]);

async function run(label, viewport, withHandoff) {
  handoff = withHandoff ? true : null;
  const ctx = await b.newContext({ viewport, deviceScaleFactor: 2 });
  const page = await ctx.newPage();
  await page.goto(`${base}/live-viewer/view?t=test`);
  await page.waitForFunction(() => document.getElementById('frame').complete && document.getElementById('frame').naturalWidth > 0, null, { timeout: 8000 });
  await page.waitForTimeout(700);
  const m = await page.evaluate(() => {
    const r = (s) => { const e = document.querySelector(s); if (!e || e.hidden) return null; const b = e.getBoundingClientRect(); return { x: b.x, y: b.y, w: b.width, h: b.height }; };
    const bodyText = document.body.innerText.trim();
    return {
      frame: r('#frame'), bar: r('#bar'), root: r('#root'),
      open: r('#open'), done: r('#done'), expand: r('#expand'), min: r('#min'),
      label: document.getElementById('label').textContent,
      bodyText,
      innerW: innerWidth, innerH: innerHeight,
      bodyBg: getComputedStyle(document.body).backgroundColor,
    };
  });
  const tag = `${label}`;
  check(`${tag}: frame fills viewer`, m.frame && Math.abs(m.frame.w - m.innerW) < 1 && Math.abs(m.frame.h - m.innerH) < 1, JSON.stringify(m.frame));
  check(`${tag}: one Open control only`, !!m.open === withHandoff, withHandoff ? 'open shown during handoff' : 'open hidden');
  check(`${tag}: Done only during handoff`, !!m.done === withHandoff);
  check(`${tag}: no visible text except label`, m.bodyText.replace(/Open\s*↗|Done|⤢|–|Your turn|\s+/g, '') === '', JSON.stringify(m.bodyText));
  check(`${tag}: toolbar is small`, m.bar && m.bar.h <= 34, `bar h=${m.bar && m.bar.h}`);
  if (m.done) check(`${tag}: Done button not huge`, m.done.h <= 28, `done h=${m.done.h}`);
  check(`${tag}: page background transparent`, m.bodyBg === 'rgba(0, 0, 0, 0)', m.bodyBg);
  await page.screenshot({ path: new URL(`../viewer-screenshots/${tag.replace(/[^a-z0-9]+/gi,'-')}.png`, import.meta.url).pathname });
  // Minimize, check the frame hides and the bar stays.
  await page.click('#min');
  await page.waitForTimeout(200);
  const minState = await page.evaluate(() => ({ frameHidden: getComputedStyle(document.getElementById('stage')).display === 'none', barVisible: !!document.getElementById('bar').getBoundingClientRect().width }));
  check(`${tag}: minimize hides frame, keeps bar`, minState.frameHidden && minState.barVisible, JSON.stringify(minState));
  await page.screenshot({ path: new URL(`../viewer-screenshots/${tag.replace(/[^a-z0-9]+/gi,'-')}-min.png`, import.meta.url).pathname });
  await page.click('#min');
  await page.waitForTimeout(200);
  await ctx.close();
}

await run('desktop-viewing', { width: 960, height: 540 }, false);
await run('desktop-handoff', { width: 960, height: 540 }, true);
await run('phone-viewing', { width: 390, height: 640 }, false);
await run('phone-handoff', { width: 390, height: 640 }, true);

await b.close();
server.close();
for (const r of results) console.log(r.join('  '));
const failed = results.filter(r => r[0] === 'FAIL').length;
console.log(failed ? `\n${failed} check(s) failed` : `\nAll ${results.length} viewer checks passed`);
process.exitCode = failed ? 1 : 0;
