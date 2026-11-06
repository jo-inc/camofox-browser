#!/usr/bin/env node
/**
 * Scenario test for a running Camofox server.
 *
 * Each target is a scenario: open a URL, run steps (wait, click, type, scroll,
 * expect), then record the fingerprint and the full visible text.
 *
 *   node scripts/test-browser-matrix.mjs --targets scripts/matrix-targets.json --runs 3 --label m1
 *   node scripts/test-browser-matrix.mjs --targets scripts/matrix-targets.json --session --label m1-session
 *
 * --session   one user session visits every scenario in turn, then compares the
 *             fingerprint on each page. Any change inside one session is drift.
 *             This is how a real person looks: one browser, many sites.
 *
 * Typed text is a benign search term from the scenario file. Nothing is logged
 * beyond the step name and outcome. Full page text is saved to bench-results/.
 */
import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { call, makeReporter } from './lib-env.mjs';

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : fallback;
};
const has = (name) => args.includes(name);
const runs = Math.max(1, parseInt(flag('--runs', '1'), 10));
const label = flag('--label', 'matrix');
const sessionMode = has('--session');
const scenarios = JSON.parse(readFileSync(resolve(flag('--targets', 'scripts/matrix-targets.json')), 'utf8'));

const BLOCK_TEXT = /access denied|verify you are human|checking your browser|unusual traffic|are you a robot|just a moment|additional verification required|troubleshooting cloudflare|attention required|ray id for this request/i;
const BLOCK_TITLE = /just a moment|attention required|access denied|forbidden/i;
const SOFTWARE_GPU = /swiftshader|llvmpipe|software/i;

const PROBE = `(() => {
  let webgl = null;
  try {
    const g = document.createElement('canvas').getContext('webgl');
    const d = g && g.getExtension('WEBGL_debug_renderer_info');
    if (d) webgl = g.getParameter(d.UNMASKED_RENDERER_WEBGL);
  } catch (e) {}
  return JSON.stringify({
    webdriver: navigator.webdriver ?? null,
    platform: navigator.platform,
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    languages: navigator.languages,
    webglRenderer: webgl,
    hardwareConcurrency: navigator.hardwareConcurrency,
    url: location.href,
    title: document.title,
    text: document.body ? document.body.innerText.slice(0, 20000) : '',
  });
})()`;

// Run one step. Returns { ok, detail }. Never throws.
async function runStep(step, ctx) {
  const { userId, tabId } = ctx;
  const q = `?userId=${encodeURIComponent(userId)}`;
  try {
    switch (step.action) {
      case 'navigate': {
        const r = await call(`/tabs/${tabId}/navigate`, { method: 'POST', body: { userId, url: step.url }, timeoutMs: 90_000 });
        return { ok: r.status === 200, detail: `navigate HTTP ${r.status}` };
      }
      case 'wait':
        await new Promise((r) => setTimeout(r, step.ms ?? 2000));
        return { ok: true, detail: `wait ${step.ms ?? 2000}ms` };
      case 'click': {
        const r = await call(`/tabs/${tabId}/click`, { method: 'POST', body: { userId, selector: step.selector }, timeoutMs: 15_000 });
        return { ok: r.status === 200, detail: `click ${step.selector}: HTTP ${r.status}` };
      }
      case 'type': {
        const r = await call(`/tabs/${tabId}/type`, { method: 'POST', body: { userId, selector: step.selector, text: step.text, pressEnter: !!step.pressEnter }, timeoutMs: 15_000 });
        return { ok: r.status === 200, detail: `type into ${step.selector}: HTTP ${r.status}` };
      }
      case 'scroll': {
        const r = await call(`/tabs/${tabId}/scroll`, { method: 'POST', body: { userId, direction: step.direction ?? 'down', amount: step.amount ?? 800 }, timeoutMs: 15_000 });
        return { ok: r.status === 200, detail: `scroll ${step.direction ?? 'down'}: HTTP ${r.status}` };
      }
      case 'expectText':
      case 'expectNoText':
      case 'expectUrl': {
        const page = await readPage(ctx);
        if (!page) return { ok: false, detail: 'could not read page' };
        if (step.action === 'expectUrl') {
          const hit = page.url.includes(step.contains);
          return { ok: hit, detail: `url contains "${step.contains}": ${hit}` };
        }
        const hit = page.text.toLowerCase().includes(step.text.toLowerCase());
        const want = step.action === 'expectText';
        return { ok: hit === want, detail: `${want ? 'text present' : 'text absent'} "${step.text}": ${hit}` };
      }
      default:
        return { ok: false, detail: `unknown step ${step.action}` };
    }
  } catch (err) {
    return { ok: false, detail: err.message };
  }
}

async function readPage(ctx) {
  const ev = await call(`/tabs/${ctx.tabId}/evaluate`, { method: 'POST', body: { userId: ctx.userId, expression: PROBE }, timeoutMs: 20_000 });
  if (typeof ev.data?.result !== 'string') return null;
  try { return JSON.parse(ev.data.result); } catch { return null; }
}

// Open a tab for a session, or reuse one. Returns the tab id or null.
async function openTab(userId, url) {
  const opened = await call('/tabs', { method: 'POST', body: { userId, sessionKey: `s-${randomUUID()}`, url }, timeoutMs: 90_000 });
  return opened.data?.tabId ?? null;
}

async function runScenario(scenario, userId, tabId) {
  const started = Date.now();
  const steps = [];
  let page = null;
  let ok = true;

  if (!tabId) {
    return { id: scenario.id, passed: false, steps: [], error: 'could not open tab', elapsedMs: Date.now() - started };
  }

  // Let the page settle, so scores and challenges have time to appear.
  await new Promise((r) => setTimeout(r, scenario.waitMs ?? 4000));

  for (const step of scenario.steps ?? []) {
    const res = await runStep(step, { userId, tabId });
    steps.push({ action: step.action, ...res });
    if (!res.ok) { ok = false; break; }
  }

  page = await readPage({ userId, tabId });
  const text = page?.text ?? '';
  const title = page?.title ?? '';
  const blocked = BLOCK_TEXT.test(text) || BLOCK_TITLE.test(title);
  if (blocked) ok = false;

  for (const t of scenario.expectText ?? []) {
    const hit = text.toLowerCase().includes(t.toLowerCase());
    steps.push({ action: 'expectText', ok: hit, detail: `text present "${t}": ${hit}` });
    if (!hit) ok = false;
  }

  const softwareGpu = !!(page?.webglRenderer && SOFTWARE_GPU.test(page.webglRenderer));
  if (softwareGpu) ok = false;

  return {
    id: scenario.id,
    category: scenario.category ?? null,
    passed: ok,
    blocked,
    steps,
    finalUrl: page?.url ?? null,
    title,
    fingerprint: page ? { webdriver: page.webdriver, platform: page.platform, timezone: page.timezone, languages: page.languages, webglRenderer: page.webglRenderer, hardwareConcurrency: page.hardwareConcurrency } : null,
    softwareGpu,
    text: text.slice(0, 20000),
    elapsedMs: Date.now() - started,
  };
}

const report = makeReporter();
const out = { label, mode: sessionMode ? 'session' : 'isolated', runs, results: [], drift: [] };

if (sessionMode) {
  // One user, one tab per scenario, same browser session throughout.
  const userId = `matrix-${randomUUID()}`;
  for (let i = 1; i <= runs; i += 1) {
    const sessionResults = [];
    for (const scenario of scenarios) {
      const tabId = await openTab(userId, scenario.url);
      const r = await runScenario(scenario, userId, tabId);
      if (tabId) await call(`/tabs/${tabId}?userId=${encodeURIComponent(userId)}`, { method: 'DELETE' });
      sessionResults.push({ ...r, run: i });
      report.check(`${scenario.id} run ${i}`, r.passed, r.error ?? `${r.elapsedMs}ms${r.blocked ? ', BLOCKED' : ''}`);
    }
    // Drift: every fingerprint field must match the first page's value.
    const base = sessionResults.find((r) => r.fingerprint)?.fingerprint;
    for (const r of sessionResults) {
      if (!r.fingerprint || !base) continue;
      for (const k of Object.keys(base)) {
        if (JSON.stringify(r.fingerprint[k]) !== JSON.stringify(base[k])) {
          out.drift.push({ run: i, scenario: r.id, field: k, first: base[k], now: r.fingerprint[k] });
        }
      }
    }
    out.results.push(...sessionResults);
    await call(`/sessions/${encodeURIComponent(userId)}`, { method: 'DELETE' });
  }
  report.check('fingerprint stable within session', out.drift.length === 0, `${out.drift.length} field change(s)`);
} else {
  for (let i = 1; i <= runs; i += 1) {
    for (const scenario of scenarios) {
      const userId = `matrix-${randomUUID()}`;
      const tabId = await openTab(userId, scenario.url);
      const r = await runScenario(scenario, userId, tabId);
      if (tabId) await call(`/tabs/${tabId}?userId=${encodeURIComponent(userId)}`, { method: 'DELETE' });
      await call(`/sessions/${encodeURIComponent(userId)}`, { method: 'DELETE' });
      out.results.push({ ...r, run: i });
      report.check(`${scenario.id} run ${i}`, r.passed, r.error ?? `${r.elapsedMs}ms${r.blocked ? ', BLOCKED' : ''}`);
    }
  }
}

const outDir = resolve('bench-results');
mkdirSync(outDir, { recursive: true });
const outFile = resolve(outDir, `${label}-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
writeFileSync(outFile, JSON.stringify(out, null, 2));
console.log(`\nResults written to ${outFile}`);
report.finish();
