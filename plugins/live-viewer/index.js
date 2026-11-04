/**
 * Live viewer: per-session screenshot viewer with optional handoff control.
 *
 * Each user gets a signed, expiring link to watch one of their own tabs.
 * The viewer page polls screenshots from the server, so the browser never
 * sees CAMOFOX_ACCESS_KEY and no shared VNC password is needed.
 *
 * During a handoff (see lib/tab-control.js) the agent pauses and a person can
 * act on the tab from the same page: click, type, press keys and scroll. The
 * viewer then shows a Done button that returns the tab to the agent.
 *
 * Routes:
 *   POST /live-viewer/links    (Bearer access key) -> signed viewer URL for one tab.
 *                              Body { userId, tabId, ttlSeconds?, control? }.
 *                              control:true requires an active handoff (409 otherwise).
 *   GET  /live-viewer/view     (none; page is static) -> HTML viewer page
 *   GET  /live-viewer/frame    (signed token)         -> PNG screenshot of that tab
 *   GET  /live-viewer/control  (signed token)         -> handoff state for that tab
 *   POST /live-viewer/input    (control token)        -> one validated input action
 *   POST /live-viewer/done     (control token)        -> return the tab to the agent
 *
 * Token = base64url(JSON{u,t,e,c?,h?}) + "." + HMAC-SHA256(accessKey, payload).
 *   u  userId            t  tabId            e  expiry (unix seconds)
 *   c  1 when the link may take control (absent on view-only links)
 *   h  start time of the handoff the link was issued for
 * A control link only works while that same handoff is active. Once the
 * handoff ends, or a newer one starts, an older link stops working.
 *
 * The token is a bearer credential for one tab until it expires. Share it only
 * with the user it was issued for.
 *
 * Privacy: typed text is forwarded to the page and never logged. Logs record
 * only the action name and the text length.
 *
 * Note: the global access-key middleware in lib/auth.js must exempt these
 * routes, since they are authorized by the signed token instead.
 */
import crypto from 'node:crypto';
import { getControl, setAgent, touchHuman } from '../../lib/tab-control.js';
import {
  DEFAULT_VIEWPORT,
  createRateLimiter,
  toViewportPoint,
  validateLiveInput,
} from '../../lib/live-input.js';

const DEFAULT_TTL_SECONDS = 30 * 60;
const MAX_TTL_SECONDS = 4 * 60 * 60;
const ACTION_TIMEOUT_MS = 5000;
const INPUT_RATE_LIMIT_PER_SECOND = 30;
const MAX_RATE_LIMITERS = 1000;

const VIEWER_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Live view</title>
<style>
  :root { color-scheme: dark; }
  html, body { margin: 0; background: #111; color: #ddd; font: 14px/1.4 system-ui, sans-serif; }
  header { display: flex; flex-wrap: wrap; align-items: center; gap: 8px 12px; padding: 10px 16px; border-bottom: 1px solid #333; }
  #status { opacity: 0.75; flex: 1 1 auto; min-width: 0; }
  #done, #open { font: inherit; min-height: 44px; padding: 0 16px; border-radius: 8px; border: 1px solid #444; background: #1d1d1d; color: #eee; text-decoration: none; display: inline-flex; align-items: center; cursor: pointer; }
  #done { background: #2b6cb0; border-color: #2b6cb0; color: #fff; font-weight: 600; }
  #done[hidden] { display: none; }
  #stage { position: relative; padding: 0 16px 16px; }
  #frame { display: block; width: 100%; height: auto; margin: 0 auto; user-select: none; -webkit-user-drag: none; }
  #stage.control #frame { cursor: pointer; outline: 2px solid #2b6cb0; outline-offset: 2px; }
  #kbd { position: fixed; left: 0; bottom: 0; width: 1px; height: 1px; opacity: 0; border: 0; padding: 0; }
  /* Thin, low-contrast scrollbar so it stays out of the way. */
  html { scrollbar-width: thin; scrollbar-color: #333 transparent; }
  ::-webkit-scrollbar { width: 4px; height: 4px; }
  ::-webkit-scrollbar-track { background: transparent; }
  ::-webkit-scrollbar-thumb { background: #333; border-radius: 2px; }
  @media (max-width: 420px) { header { padding: 10px 12px; } #stage { padding: 0 12px 12px; } }
</style>
</head>
<body>
<header>
  <span>Live view</span>
  <span id="status" role="status" aria-live="polite">connecting…</span>
  <button id="done" type="button" hidden>Done</button>
  <a id="open" href="#" target="_blank" rel="noopener">Open in new tab</a>
</header>
<main id="stage">
  <img id="frame" alt="Live browser view" draggable="false">
  <textarea id="kbd" aria-hidden="true" tabindex="-1" autocomplete="off" autocapitalize="off" spellcheck="false"></textarea>
</main>
<script>
  var token = new URLSearchParams(location.search).get('t') || '';
  var img = document.getElementById('frame');
  var stage = document.getElementById('stage');
  var statusEl = document.getElementById('status');
  var doneBtn = document.getElementById('done');
  var openLink = document.getElementById('open');
  var kbd = document.getElementById('kbd');

  var canControl = false;
  var controlActive = false;
  var expired = false;
  var busy = false;
  var previousUrl = null;
  var inputChain = Promise.resolve();
  var pendingText = '';
  var flushTimer = null;
  var scrollAcc = 0;
  var scrollTimer = null;

  openLink.href = location.href;

  function setStatus(text) { statusEl.textContent = text; }

  function renderControl() {
    var showDone = canControl && controlActive;
    doneBtn.hidden = !showDone;
    stage.className = showDone ? 'control' : '';
  }

  function endedByServer(res) {
    if (res.status === 401) { expired = true; setStatus('link expired'); return true; }
    return false;
  }

  // Inputs go out one at a time so the server receives them in the order typed.
  function sendInput(body) {
    if (!canControl || !controlActive || expired) return;
    inputChain = inputChain.then(function () {
      return fetch('/live-viewer/input?t=' + encodeURIComponent(token), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        cache: 'no-store'
      }).then(function (res) {
        if (endedByServer(res)) return;
        if (res.status === 409) { controlActive = false; renderControl(); setStatus('agent resumed'); }
      }).catch(function () { setStatus('reconnecting…'); });
    });
  }

  function flushText() {
    clearTimeout(flushTimer);
    flushTimer = null;
    if (!pendingText) return;
    var text = pendingText.slice(0, 500);
    pendingText = pendingText.slice(text.length);
    sendInput({ action: 'type', text: text });
    if (pendingText) flushText();
  }

  function queueText(text) {
    pendingText += text;
    if (!flushTimer) flushTimer = setTimeout(flushText, 120);
  }

  function flushScroll() {
    clearTimeout(scrollTimer);
    scrollTimer = null;
    var delta = Math.max(-2000, Math.min(2000, Math.round(scrollAcc)));
    scrollAcc = 0;
    if (delta !== 0) sendInput({ action: 'scroll', deltaY: delta });
  }

  img.addEventListener('click', function (e) {
    if (!canControl || !controlActive) return;
    var rect = img.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    var x = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
    var y = Math.min(1, Math.max(0, (e.clientY - rect.top) / rect.height));
    flushText();
    sendInput({ action: e.detail >= 2 ? 'dblclick' : 'click', x: x, y: y });
    kbd.focus({ preventScroll: true });
  });

  stage.addEventListener('wheel', function (e) {
    if (!canControl || !controlActive) return;
    e.preventDefault();
    scrollAcc += e.deltaY;
    if (!scrollTimer) scrollTimer = setTimeout(flushScroll, 100);
  }, { passive: false });

  var SPECIAL_KEYS = { Enter: 1, Tab: 1, Backspace: 1, Delete: 1, Escape: 1, ArrowUp: 1, ArrowDown: 1, ArrowLeft: 1, ArrowRight: 1, Home: 1, End: 1, PageUp: 1, PageDown: 1 };

  kbd.addEventListener('keydown', function (e) {
    if (!canControl || !controlActive) return;
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (SPECIAL_KEYS[e.key]) {
      e.preventDefault();
      flushText();
      sendInput({ action: 'key', key: e.key });
    }
  });

  kbd.addEventListener('input', function (e) {
    if (e.isComposing) return;
    var value = kbd.value;
    kbd.value = '';
    if (value) queueText(value);
  });

  kbd.addEventListener('compositionend', function () {
    var value = kbd.value;
    kbd.value = '';
    if (value) queueText(value);
  });

  doneBtn.addEventListener('click', function () {
    if (!canControl || !controlActive) return;
    doneBtn.disabled = true;
    flushText();
    inputChain = inputChain.then(function () {
      return fetch('/live-viewer/done?t=' + encodeURIComponent(token), { method: 'POST', cache: 'no-store' })
        .then(function (res) {
          if (endedByServer(res)) return;
          controlActive = false;
          renderControl();
          setStatus('returned to agent');
        })
        .catch(function () { setStatus('reconnecting…'); })
        .finally(function () { doneBtn.disabled = false; });
    });
  });

  async function refreshControl() {
    try {
      var res = await fetch('/live-viewer/control?t=' + encodeURIComponent(token), { cache: 'no-store' });
      if (endedByServer(res)) return;
      if (!res.ok) return;
      var data = await res.json();
      var wasActive = controlActive;
      canControl = !!data.canControl;
      controlActive = !!data.handoff;
      renderControl();
      if (wasActive && !controlActive) setStatus('agent resumed');
    } catch (err) {
      setStatus('reconnecting…');
    }
  }

  async function refreshFrame() {
    try {
      var res = await fetch('/live-viewer/frame?t=' + encodeURIComponent(token), { cache: 'no-store' });
      if (res.ok) {
        var url = URL.createObjectURL(await res.blob());
        img.src = url;
        if (previousUrl) URL.revokeObjectURL(previousUrl);
        previousUrl = url;
        if (!controlActive) setStatus('live · ' + new Date().toLocaleTimeString());
        else setStatus('you are in control · ' + new Date().toLocaleTimeString());
      } else if (res.status === 401) {
        expired = true;
        setStatus('link expired');
      } else if (res.status === 404) {
        setStatus('tab closed');
      } else {
        setStatus('unavailable (' + res.status + ')');
      }
    } catch (err) {
      setStatus('reconnecting…');
    }
  }

  async function loop() {
    if (expired) return;
    if (!busy) {
      busy = true;
      try {
        await refreshControl();
        if (!expired) await refreshFrame();
      } finally {
        busy = false;
      }
    }
    if (!expired) setTimeout(loop, controlActive ? 600 : 1000);
  }

  loop();
</script>
</body>
</html>
`;

function b64url(value) {
  return Buffer.from(value).toString('base64url');
}

function sign(secret, payloadB64) {
  return crypto.createHmac('sha256', secret).update(payloadB64).digest('base64url');
}

/**
 * Create a signed token. Exported for tests.
 * @param {string} secret
 * @param {{userId: string, tabId: string, ttlSeconds: number, control?: boolean, handoffSince?: number}} opts
 */
export function issueToken(secret, { userId, tabId, ttlSeconds, control = false, handoffSince }) {
  const exp = Math.floor(Date.now() / 1000) + ttlSeconds;
  const claims = { u: userId, t: tabId, e: exp };
  if (control) {
    claims.c = 1;
    claims.h = handoffSince;
  }
  const payload = b64url(JSON.stringify(claims));
  return `${payload}.${sign(secret, payload)}`;
}

/**
 * Verify a token. Returns its claims, or null when the token is malformed,
 * tampered with, or expired. Exported for tests.
 */
export function verifyToken(secret, token) {
  if (typeof token !== 'string') return null;
  const dot = token.indexOf('.');
  if (dot <= 0) return null;

  const payload = token.slice(0, dot);
  const signature = Buffer.from(token.slice(dot + 1));
  const expected = Buffer.from(sign(secret, payload));
  if (signature.length !== expected.length || !crypto.timingSafeEqual(signature, expected)) return null;

  let claims;
  try {
    claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  if (!claims || typeof claims.u !== 'string' || typeof claims.t !== 'string' || typeof claims.e !== 'number') {
    return null;
  }
  if (claims.c !== undefined && claims.c !== 1) return null;
  if (claims.c === 1 && typeof claims.h !== 'number') return null;
  if (Math.floor(Date.now() / 1000) > claims.e) return null;
  return claims;
}

function findPage(sessions, userId, tabId) {
  const session = sessions.get(String(userId));
  if (!session?.tabGroups) return null;
  for (const group of session.tabGroups.values()) {
    const state = group.get(tabId);
    if (state?.page && !state.page.isClosed()) return state.page;
  }
  return null;
}

/**
 * The handoff this control link was issued for, if it is still the active one.
 * Returns null for view-only links, when no handoff is active, and when the
 * active handoff is a different one.
 */
function activeHandoff(claims) {
  if (claims.c !== 1) return null;
  const control = getControl(claims.t);
  if (control.mode !== 'human' || control.since !== claims.h) return null;
  return control;
}

function withTimeout(promise, ms) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error('action timed out')), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

async function performInput(page, input) {
  const viewport = page.viewportSize() || DEFAULT_VIEWPORT;
  switch (input.action) {
    case 'click': {
      const p = toViewportPoint(input.x, input.y, viewport);
      await page.mouse.click(p.x, p.y);
      return;
    }
    case 'dblclick': {
      const p = toViewportPoint(input.x, input.y, viewport);
      await page.mouse.click(p.x, p.y, { clickCount: 2 });
      return;
    }
    case 'type':
      await page.keyboard.type(input.text);
      return;
    case 'key':
      await page.keyboard.press(input.key);
      return;
    case 'scroll':
      // Wheel events land under the pointer, so park it mid-viewport first.
      await page.mouse.move(Math.round(viewport.width / 2), Math.round(viewport.height / 2));
      await page.mouse.wheel(0, input.deltaY);
      return;
    default:
      throw new Error('unknown action');
  }
}

export async function register(app, ctx) {
  const { auth, sessions, config, log } = ctx;
  const secret = config.accessKey;

  // Inputs for one tab run strictly in order, one at a time.
  const tabQueues = new Map();
  function enqueue(tabId, fn) {
    const previous = tabQueues.get(tabId) || Promise.resolve();
    const run = previous.catch(() => {}).then(() => withTimeout(fn(), ACTION_TIMEOUT_MS));
    const tail = run.catch(() => {}).then(() => {
      if (tabQueues.get(tabId) === tail) tabQueues.delete(tabId);
    });
    tabQueues.set(tabId, tail);
    return run;
  }

  // One limiter per control link, so a single viewer cannot flood the page.
  const rateLimiters = new Map();
  function limiterFor(claims) {
    const key = `${claims.u}:${claims.t}:${claims.h}`;
    let limiter = rateLimiters.get(key);
    if (!limiter) {
      if (rateLimiters.size >= MAX_RATE_LIMITERS) rateLimiters.clear();
      limiter = createRateLimiter({ limit: INPUT_RATE_LIMIT_PER_SECOND, windowMs: 1000 });
      rateLimiters.set(key, limiter);
    }
    return limiter;
  }

  app.post('/live-viewer/links', auth(), (req, res) => {
    if (!secret) {
      return res.status(503).json({ error: 'CAMOFOX_ACCESS_KEY must be set to issue viewer links' });
    }

    const userId = req.body?.userId;
    const tabId = req.body?.tabId;
    if (typeof userId !== 'string' || !userId || typeof tabId !== 'string' || !tabId) {
      return res.status(400).json({ error: 'userId and tabId are required' });
    }
    if (req.body?.control !== undefined && typeof req.body.control !== 'boolean') {
      return res.status(400).json({ error: 'control must be a boolean' });
    }
    if (!findPage(sessions, userId, tabId)) {
      return res.status(404).json({ error: 'Tab not found' });
    }

    const wantsControl = req.body?.control === true;
    let handoffSince;
    if (wantsControl) {
      const control = getControl(tabId);
      if (control.mode !== 'human') {
        return res.status(409).json({
          error: 'handoff_not_active',
          message: 'Start a handoff on this tab before issuing a control link.',
        });
      }
      handoffSince = control.since;
    }

    const requested = Number(req.body?.ttlSeconds);
    const ttlSeconds = Number.isFinite(requested) && requested > 0
      ? Math.min(requested, MAX_TTL_SECONDS)
      : DEFAULT_TTL_SECONDS;

    const token = issueToken(secret, { userId, tabId, ttlSeconds, control: wantsControl, handoffSince });
    const proto = req.get('x-forwarded-proto') || req.protocol;
    const base = `${proto}://${req.get('host')}`;
    log('info', 'live-viewer link issued', { userId, tabId, ttlSeconds, control: wantsControl });

    res.json({
      url: `${base}/live-viewer/view?t=${token}`,
      expiresAt: new Date(Date.now() + ttlSeconds * 1000).toISOString(),
      control: wantsControl,
    });
  });

  app.get('/live-viewer/view', (_req, res) => {
    res.set('Cache-Control', 'no-store').type('html').send(VIEWER_HTML);
  });

  app.get('/live-viewer/frame', async (req, res) => {
    if (!secret) return res.status(503).json({ error: 'Live viewer unavailable' });

    const claims = verifyToken(secret, req.query.t);
    if (!claims) return res.status(401).json({ error: 'Invalid or expired link' });

    const page = findPage(sessions, claims.u, claims.t);
    if (!page) return res.status(404).json({ error: 'Tab not found' });

    try {
      const buffer = await page.screenshot({ type: 'png', fullPage: false, timeout: 5000 });
      res.set({ 'Content-Type': 'image/png', 'Cache-Control': 'no-store' }).send(buffer);
    } catch (err) {
      log('warn', 'live-viewer screenshot failed', { error: err.message });
      res.status(503).json({ error: 'Screenshot unavailable' });
    }
  });

  app.get('/live-viewer/control', (req, res) => {
    if (!secret) return res.status(503).json({ error: 'Live viewer unavailable' });

    const claims = verifyToken(secret, req.query.t);
    if (!claims) return res.status(401).json({ error: 'Invalid or expired link' });

    const handoff = activeHandoff(claims);
    res.set('Cache-Control', 'no-store').json({
      canControl: claims.c === 1,
      handoff: handoff ? { until: new Date(handoff.until).toISOString(), reason: handoff.reason } : null,
    });
  });

  app.post('/live-viewer/input', async (req, res) => {
    if (!secret) return res.status(503).json({ error: 'Live viewer unavailable' });

    const claims = verifyToken(secret, req.query.t);
    if (!claims) return res.status(401).json({ error: 'Invalid or expired link' });
    if (!activeHandoff(claims)) {
      return res.status(409).json({ error: 'handoff_not_active', message: 'No handoff is active for this tab.' });
    }
    if (!limiterFor(claims).take()) {
      return res.status(429).json({ error: 'Too many inputs; slow down' });
    }

    const input = validateLiveInput(req.body);
    if (!input.ok) return res.status(400).json({ error: input.error });

    const page = findPage(sessions, claims.u, claims.t);
    if (!page) return res.status(404).json({ error: 'Tab not found' });

    try {
      await enqueue(claims.t, () => performInput(page, input));
      touchHuman(claims.t);
      // Typed text is never logged; only its length is.
      log('info', 'live-viewer input', {
        userId: claims.u,
        tabId: claims.t,
        action: input.action,
        length: input.text ? input.text.length : undefined,
      });
      res.json({ ok: true });
    } catch (err) {
      log('warn', 'live-viewer input failed', { tabId: claims.t, action: input.action, error: err.message });
      res.status(503).json({ error: 'Input could not be applied' });
    }
  });

  app.post('/live-viewer/done', (req, res) => {
    if (!secret) return res.status(503).json({ error: 'Live viewer unavailable' });

    const claims = verifyToken(secret, req.query.t);
    if (!claims) return res.status(401).json({ error: 'Invalid or expired link' });
    if (claims.c !== 1) {
      return res.status(403).json({ error: 'control_required', message: 'This link cannot control the tab.' });
    }

    // Release only the handoff this link belongs to. A stale link must not end a newer handoff.
    if (activeHandoff(claims)) {
      setAgent(claims.t);
      log('info', 'live-viewer handoff returned to agent', { userId: claims.u, tabId: claims.t });
    }
    res.set('Cache-Control', 'no-store').json({ ok: true, status: 'agent' });
  });
}
