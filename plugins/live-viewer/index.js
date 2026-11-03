/**
 * Live viewer: per-session screenshot viewer with an action overlay.
 *
 * Each user gets a signed, expiring link to watch one of their own tabs.
 * The viewer page polls screenshots and the tab's action log from the server,
 * so the browser never sees CAMOFOX_ACCESS_KEY and no shared VNC password is needed.
 *
 * Routes:
 *   POST /live-viewer/links    (Bearer access key)     -> signed viewer URL for one tab
 *   GET  /live-viewer/view     (none; static page)     -> HTML viewer page
 *   GET  /live-viewer/frame    (signed token)          -> PNG screenshot of that tab
 *   GET  /live-viewer/events   (signed token, since=N) -> action log entries after seq N
 *
 * Action log: the server emits 'tab:click:target' (screen position of each click),
 * 'tab:navigated', and 'tab:type'. This plugin keeps the last MAX_ACTIONS per tab.
 * Typed text is never stored, only its length, so passwords do not reach the log.
 *
 * Token = base64url(JSON{u,t,e}) + "." + HMAC-SHA256(accessKey, payload).
 * The token is a bearer credential for one tab until it expires. Anyone who
 * holds the link can watch that tab, so share it only with the user it was
 * issued for.
 *
 * lib/auth.js exempts GET /live-viewer/view, /live-viewer/frame, and /live-viewer/events
 * from the access-key check, since those routes are authorized by the signed token.
 */
import crypto from 'node:crypto';

const DEFAULT_TTL_SECONDS = 30 * 60;
const MAX_TTL_SECONDS = 4 * 60 * 60;
const MAX_ACTIONS = 50;

const VIEWER_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Live view</title>
<style>
  html, body { margin: 0; background: #111; color: #ddd; font: 14px system-ui, sans-serif; }
  header { padding: 8px 12px; border-bottom: 1px solid #333; }
  #status { opacity: 0.7; margin-left: 8px; }
  #stage { position: relative; max-width: 100%; }
  #frame { display: block; width: 100%; height: auto; }
  #dot {
    position: absolute; width: 18px; height: 18px; margin: -9px 0 0 -9px;
    border-radius: 50%; background: rgba(235, 30, 30, 0.85);
    box-shadow: 0 0 0 4px rgba(235, 30, 30, 0.3); pointer-events: none;
    display: none; transition: opacity 0.4s;
  }
  #log { list-style: none; margin: 0; padding: 8px 12px; border-top: 1px solid #333; font-size: 13px; }
  #log li { padding: 3px 0; opacity: 0.85; }
  #log li.old { opacity: 0.45; }
</style>
</head>
<body>
<header>Live view <span id="status">connecting…</span></header>
<div id="stage">
  <img id="frame" alt="Live browser view">
  <div id="dot"></div>
</div>
<ul id="log"></ul>
<script>
  const token = new URLSearchParams(location.search).get('t') || '';
  const img = document.getElementById('frame');
  const dot = document.getElementById('dot');
  const logEl = document.getElementById('log');
  const statusEl = document.getElementById('status');
  let busy = false;
  let previousUrl = null;
  let sinceSeq = 0;
  let actions = [];
  let dotHideTimer = null;

  function describe(a) {
    if (a.kind === 'click') return 'Clicked on the page';
    if (a.kind === 'navigate') return 'Went to ' + (a.url || 'a new page');
    if (a.kind === 'type') return 'Typed ' + a.chars + ' character' + (a.chars === 1 ? '' : 's');
    return a.kind;
  }

  function showDot(a) {
    if (a.kind !== 'click' || !a.viewport || !a.viewport.width) return;
    dot.style.left = (a.x / a.viewport.width * 100) + '%';
    dot.style.top = (a.y / a.viewport.height * 100) + '%';
    dot.style.opacity = '1';
    dot.style.display = 'block';
    clearTimeout(dotHideTimer);
    dotHideTimer = setTimeout(() => { dot.style.opacity = '0'; }, 1500);
  }

  function renderLog() {
    logEl.innerHTML = '';
    const recent = actions.slice(-8).reverse();
    recent.forEach((a, i) => {
      const li = document.createElement('li');
      if (i > 0) li.className = 'old';
      li.textContent = new Date(a.at).toLocaleTimeString() + '  ' + describe(a);
      logEl.appendChild(li);
    });
  }

  async function pollEvents() {
    const res = await fetch('/live-viewer/events?t=' + encodeURIComponent(token) + '&since=' + sinceSeq, { cache: 'no-store' });
    if (!res.ok) return;
    const body = await res.json();
    if (!Array.isArray(body.events) || body.events.length === 0) return;
    for (const a of body.events) {
      actions.push(a);
      sinceSeq = Math.max(sinceSeq, a.seq);
      showDot(a);
    }
    actions = actions.slice(-MAX_ACTIONS);
    renderLog();
  }

  async function tick() {
    if (busy) return;
    busy = true;
    try {
      const res = await fetch('/live-viewer/frame?t=' + encodeURIComponent(token), { cache: 'no-store' });
      if (res.ok) {
        const url = URL.createObjectURL(await res.blob());
        img.src = url;
        if (previousUrl) URL.revokeObjectURL(previousUrl);
        previousUrl = url;
        statusEl.textContent = 'live · ' + new Date().toLocaleTimeString();
        await pollEvents();
      } else if (res.status === 401) {
        statusEl.textContent = 'link expired';
      } else if (res.status === 404) {
        statusEl.textContent = 'tab closed';
      } else {
        statusEl.textContent = 'unavailable (' + res.status + ')';
      }
    } catch {
      statusEl.textContent = 'reconnecting…';
    } finally {
      busy = false;
    }
  }

  tick();
  setInterval(tick, 1000);
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

function issueToken(secret, { userId, tabId, ttlSeconds }) {
  const exp = Math.floor(Date.now() / 1000) + ttlSeconds;
  const payload = b64url(JSON.stringify({ u: userId, t: tabId, e: exp }));
  return `${payload}.${sign(secret, payload)}`;
}

function verifyToken(secret, token) {
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

export async function register(app, ctx) {
  const { auth, sessions, config, log, events } = ctx;
  const secret = config.accessKey;

  // Per-tab action log, keyed by "userId:tabId". Bounded and cleared when the tab closes.
  const actionLogs = new Map();
  let nextSeq = 1;
  const keyOf = (userId, tabId) => `${userId}:${tabId}`;

  function record(userId, tabId, entry) {
    if (!userId || !tabId) return;
    const key = keyOf(String(userId), String(tabId));
    let list = actionLogs.get(key);
    if (!list) {
      list = [];
      actionLogs.set(key, list);
    }
    list.push({ seq: nextSeq++, at: Date.now(), ...entry });
    if (list.length > MAX_ACTIONS) list.splice(0, list.length - MAX_ACTIONS);
  }

  events.on('tab:click:target', ({ userId, tabId, x, y, viewport }) => {
    if (!Number.isFinite(x) || !Number.isFinite(y)) return;
    record(userId, tabId, { kind: 'click', x, y, viewport: viewport || null });
  });

  events.on('tab:navigated', ({ userId, tabId, url }) => {
    record(userId, tabId, { kind: 'navigate', url: typeof url === 'string' ? url : null });
  });

  events.on('tab:type', ({ userId, tabId, text }) => {
    // Length only. The typed text itself is never stored.
    record(userId, tabId, { kind: 'type', chars: typeof text === 'string' ? text.length : 0 });
  });

  events.on('tab:destroyed', ({ userId, tabId }) => {
    actionLogs.delete(keyOf(String(userId), String(tabId)));
  });

  app.post('/live-viewer/links', auth(), (req, res) => {
    if (!secret) {
      return res.status(503).json({ error: 'CAMOFOX_ACCESS_KEY must be set to issue viewer links' });
    }

    const userId = req.body?.userId;
    const tabId = req.body?.tabId;
    if (typeof userId !== 'string' || !userId || typeof tabId !== 'string' || !tabId) {
      return res.status(400).json({ error: 'userId and tabId are required' });
    }
    if (!findPage(sessions, userId, tabId)) {
      return res.status(404).json({ error: 'Tab not found' });
    }

    const requested = Number(req.body?.ttlSeconds);
    const ttlSeconds = Number.isFinite(requested) && requested > 0
      ? Math.min(requested, MAX_TTL_SECONDS)
      : DEFAULT_TTL_SECONDS;

    const token = issueToken(secret, { userId, tabId, ttlSeconds });
    const proto = req.get('x-forwarded-proto') || req.protocol;
    const base = `${proto}://${req.get('host')}`;
    log('info', 'live-viewer link issued', { userId, tabId, ttlSeconds });

    res.json({
      url: `${base}/live-viewer/view?t=${token}`,
      expiresAt: new Date(Date.now() + ttlSeconds * 1000).toISOString(),
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

  app.get('/live-viewer/events', (req, res) => {
    if (!secret) return res.status(503).json({ error: 'Live viewer unavailable' });

    const claims = verifyToken(secret, req.query.t);
    if (!claims) return res.status(401).json({ error: 'Invalid or expired link' });

    const since = Number(req.query.since) || 0;
    const list = actionLogs.get(keyOf(claims.u, claims.t)) || [];
    const fresh = list.filter((entry) => entry.seq > since);
    const seq = fresh.length ? fresh[fresh.length - 1].seq : since;
    res.set('Cache-Control', 'no-store').json({ seq, events: fresh });
  });
}
