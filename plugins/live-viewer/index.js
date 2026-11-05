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
 * The viewer page itself is plugins/live-viewer/viewer.html. It is built to be
 * embedded in an iframe: the frame fills the iframe, and a small toolbar offers
 * Open, Done (during a handoff), expand, and minimize.
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
import { readFileSync } from 'node:fs';
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

// Read once at startup. Edit viewer.html to change the page; no server code changes needed.
const VIEWER_HTML = readFileSync(new URL('./viewer.html', import.meta.url), 'utf8');

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
  const { auth, sessions, config, log, events } = ctx;
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
      events?.emit('handoff:ended', { userId: claims.u, tabId: claims.t, reason: 'done' });
    }
    res.set('Cache-Control', 'no-store').json({ ok: true, status: 'agent' });
  });
}
