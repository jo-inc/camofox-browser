/**
 * Live viewer: per-session screenshot viewer.
 *
 * Each user gets a signed, expiring link to watch one of their own tabs.
 * The viewer page polls screenshots from the server, so the browser never
 * sees CAMOFOX_ACCESS_KEY and no shared VNC password is needed.
 *
 * Routes:
 *   POST /live-viewer/links   (Bearer access key)  -> signed viewer URL for one tab
 *   GET  /live-viewer/view    (none; page is static) -> HTML viewer page
 *   GET  /live-viewer/frame   (signed token)       -> PNG screenshot of that tab
 *
 * Token = base64url(JSON{u,t,e}) + "." + HMAC-SHA256(accessKey, payload).
 * The token is a bearer credential for one tab until it expires. Anyone who
 * holds the link can watch that tab, so share it only with the user it was
 * issued for.
 *
 * Note: the global access-key middleware in lib/auth.js must exempt
 * GET /live-viewer/view and GET /live-viewer/frame, since those routes are
 * authorized by the signed token instead.
 */
import crypto from 'node:crypto';

const DEFAULT_TTL_SECONDS = 30 * 60;
const MAX_TTL_SECONDS = 4 * 60 * 60;

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
  img { display: block; max-width: 100%; height: auto; margin: 0 auto; }
  /* Thin, low-contrast scrollbar so it stays out of the way. */
  html { scrollbar-width: thin; scrollbar-color: #333 transparent; }
  ::-webkit-scrollbar { width: 4px; height: 4px; }
  ::-webkit-scrollbar-track { background: transparent; }
  ::-webkit-scrollbar-thumb { background: #333; border-radius: 2px; }
</style>
</head>
<body>
<header>Live view <span id="status">connecting…</span></header>
<img id="frame" alt="Live browser view">
<script>
  const token = new URLSearchParams(location.search).get('t') || '';
  const img = document.getElementById('frame');
  const statusEl = document.getElementById('status');
  let busy = false;
  let previousUrl = null;

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
  const { auth, sessions, config, log } = ctx;
  const secret = config.accessKey;

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
}
