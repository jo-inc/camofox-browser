import { Camoufox, launchOptions } from 'camoufox-js';
import { VirtualDisplay } from 'camoufox-js/dist/virtdisplay.js';
import { firefox } from 'playwright-core';
import express from 'express';
import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import { expandMacro } from './lib/macros.js';
import { loadConfig } from './lib/config.js';
import { normalizePlaywrightProxy, createProxyPool, buildProxyUrl } from './lib/proxy.js';
import { createFlyHelpers } from './lib/fly.js';
import { createPluginEvents, loadPlugins } from './lib/plugins.js';
import { requireAuth, accessKeyMiddleware, timingSafeCompare as _timingSafeCompare, isLoopbackAddress as _isLoopbackAddress } from './lib/auth.js';
import { windowSnapshot } from './lib/snapshot.js';
import {
  MAX_DOWNLOAD_INLINE_BYTES,
  clearTabDownloads,
  clearSessionDownloads,
  attachDownloadListener,
  getDownloadsList,
} from './lib/downloads.js';
import { extractPageImages } from './lib/images.js';
import { extractDeterministic, validateSchema as validateExtractSchema } from './lib/extract.js';
import {
  ensureTracesDir, resolveTracePath, tracePathFor, makeTraceFilename,
  listUserTraces, statTrace, deleteTrace, sweepOldTraces,
} from './lib/tracing.js';

import {
  initMetrics, getRegister, isMetricsEnabled, createMetric,
  startMemoryReporter, stopMemoryReporter,
} from './lib/metrics.js';
import { actionFromReq, classifyError } from './lib/request-utils.js';
import { cleanupOrphanedTempFiles, cleanupStaleFirefoxProfiles } from './lib/tmp-cleanup.js';
import { coalesceInflight } from './lib/inflight.js';
import { createReporter, createTabHealthTracker, collectResourceSnapshot, classifyProxyError } from './lib/reporter.js';
import { mountDocs } from './lib/openapi.js';

const CONFIG = loadConfig();

// --- Crash reporter (opt-in, anonymized GitHub issues) ---
import { readFileSync } from 'fs';
const _pkgVersion = (() => { try { return JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')).version; } catch { return 'unknown'; } })();
const reporter = createReporter({ ...CONFIG, version: _pkgVersion });
function _countTabs() {
  let total = 0;
  for (const session of sessions.values()) {
    for (const group of session.tabGroups.values()) total += group.size;
  }
  return total;
}
function _browserPid() {
  try { return browser?.process?.()?.pid ?? null; } catch { return null; }
}
function _resourceOpts() {
  return { sessionCount: sessions.size, tabCount: _countTabs(), browserPid: _browserPid() };
}
reporter.startWatchdog(30_000, () => {
  const summary = [];
  for (const [sid, session] of sessions) {
    const tabUrls = [];
    for (const [tid, tab] of session.tabs) {
      try {
        const url = tab.page?.url?.() || 'unknown';
        tabUrls.push(url);
      } catch { tabUrls.push('error'); }
    }
    if (tabUrls.length > 0) summary.push({ session: sid, tabs: tabUrls.length, urls: tabUrls });
  }
  return { resourceOpts: _resourceOpts(), sessions: summary.length, summary };
});

// --- Plugin event bus ---
const pluginEvents = createPluginEvents();

// --- Shared auth middleware ---
const authMiddleware = () => requireAuth(CONFIG);

const {
  requestsTotal, requestDuration, pageLoadDuration, snapshotBytes,
  activeTabsGauge, tabLockQueueDepth,
  tabLockTimeoutsTotal,
  failuresTotal, browserRestartsTotal, tabsDestroyedTotal,
  sessionsExpiredTotal, tabsReapedTotal, tabsRecycledTotal,
} = await initMetrics({ enabled: CONFIG.prometheusEnabled });

// --- Structured logging ---
function log(level, msg, fields = {}) {
  const entry = {
    ts: new Date().toISOString(),
    level,
    msg,
    ...fields,
  };
  const line = JSON.stringify(entry);
  if (level === 'error') {
    process.stderr.write(line + '\n');
  } else {
    process.stdout.write(line + '\n');
  }
}

const app = express();
app.use(express.json({ limit: '100kb' }));

// Request logging + metrics middleware
app.use((req, res, next) => {
  const reqId = crypto.randomUUID().slice(0, 8);
  req.reqId = reqId;
  req.startTime = Date.now();

  const userId = req.body?.userId || req.query?.userId || '-';
  if (req.path !== '/health') {
    log('info', 'req', { reqId, method: req.method, path: req.path, userId });
  }

  const action = actionFromReq(req);
  reporter.trackRoute(`${req.method} ${req.route?.path || '[unmatched]'}`);
  const done = requestDuration.startTimer({ action });

  const origEnd = res.end.bind(res);
  res.end = function (...args) {
    const ms = Date.now() - req.startTime;
    const isErrorStatus = res.statusCode >= 400;
    requestsTotal.labels(action, isErrorStatus ? 'error' : 'success').inc();
    done();

    if (req.path !== '/health') {
      log('info', 'res', { reqId, status: res.statusCode, ms });
    }

    return origEnd(...args);
  };

  next();
});

// --- Horizontal scaling (Fly.io multi-machine) ---
const fly = createFlyHelpers(CONFIG);
const FLY_MACHINE_ID = fly.machineId;

// Route tab requests to the owning machine via fly-replay header.
app.use('/tabs/:tabId', fly.replayMiddleware(log));

// Access-key middleware: gates every route when CAMOFOX_ACCESS_KEY is set.
// Exempts /health (Docker healthcheck) and routes that have their own
// dedicated keys (cookie import -> CAMOFOX_API_KEY, /stop -> CAMOFOX_ADMIN_KEY)
// so each key gates a distinct surface. When unset, behavior is unchanged.
app.use(accessKeyMiddleware(CONFIG));

const ALLOWED_URL_SCHEMES = ['http:', 'https:'];

// Interactive roles to include - exclude combobox to avoid opening complex widgets
// (date pickers, dropdowns) that can interfere with navigation
const INTERACTIVE_ROLES = [
  'button', 'link', 'textbox', 'checkbox', 'radio',
  'menuitem', 'tab', 'searchbox', 'slider', 'spinbutton', 'switch'
  // 'combobox' excluded - can trigger date pickers and complex dropdowns
];

// Patterns to skip (date pickers, calendar widgets)
const SKIP_PATTERNS = [
  /date/i, /calendar/i, /picker/i, /datepicker/i
];

// timingSafeCompare and isLoopbackAddress imported from lib/auth.js
const timingSafeCompare = _timingSafeCompare;
const isLoopbackAddress = _isLoopbackAddress;

// Custom error for stale/unknown element refs -- returned as 422 instead of 500
class StaleRefsError extends Error {
  constructor(ref, maxRef, totalRefs) {
    super(`Unknown ref: ${ref} (valid refs: e1-${maxRef}, ${totalRefs} total). Refs reset after navigation - call snapshot first.`);
    this.name = 'StaleRefsError';
    this.code = 'stale_refs';
    this.ref = ref;
  }
}

function safeError(err) {
  if (CONFIG.nodeEnv === 'production') {
    log('error', 'internal error', { error: err.message, stack: err.stack });
    return 'Internal server error';
  }
  return err.message;
}

// Send error response with appropriate status code (422 for stale refs, 500 otherwise)
function sendError(res, err, extraFields = {}) {
  const status = err instanceof StaleRefsError ? 422 : (err.statusCode || 500);
  const body = { error: safeError(err), ...extraFields };
  if (err instanceof StaleRefsError) {
    body.code = 'stale_refs';
    body.ref = err.ref;
  }
  res.status(status).json(body);
}

function validateUrl(url) {
  try {
    const parsed = new URL(url);
    if (!ALLOWED_URL_SCHEMES.includes(parsed.protocol)) {
      return `Blocked URL scheme: ${parsed.protocol} (only http/https allowed)`;
    }
    return null;
  } catch {
    return `Invalid URL: ${url}`;
  }
}

// isLoopbackAddress -- now imported from lib/auth.js (see top of file)

// Import cookies into a user's browser context (Playwright cookies format)
// POST /sessions/:userId/cookies { cookies: Cookie[] }
//
// SECURITY:
// Cookie injection moves this from "anonymous browsing" to "authenticated browsing".
/**
 * @openapi
 * /sessions/{userId}/cookies:
 *   post:
 *     tags: [Sessions]
 *     summary: Import cookies into a user session
 *     description: Import cookies for authenticated browsing. Requires BearerAuth in production.
 *     security:
 *       - BearerAuth: []
 *     parameters:
 *       - name: userId
 *         in: path
 *         required: true
 *         schema:
 *           type: string
 *         description: Session owner identifier.
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [cookies]
 *             properties:
 *               cookies:
 *                 type: array
 *                 maxItems: 500
 *                 items:
 *                   type: object
 *                   required: [name, value, domain]
 *                   properties:
 *                     name:
 *                       type: string
 *                     value:
 *                       type: string
 *                     domain:
 *                       type: string
 *                     path:
 *                       type: string
 *                     expires:
 *                       type: number
 *                     httpOnly:
 *                       type: boolean
 *                     secure:
 *                       type: boolean
 *                     sameSite:
 *                       type: string
 *                       enum: [Strict, Lax, None]
 *     responses:
 *       200:
 *         description: Cookies imported.
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 ok:
 *                   type: boolean
 *                 userId:
 *                   type: string
 *                 count:
 *                   type: integer
 *       400:
 *         description: Invalid cookie data.
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *       403:
 *         description: Forbidden.
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 */
app.post('/sessions/:userId/cookies', express.json({ limit: '512kb' }), async (req, res) => {
  try {
    if (CONFIG.apiKey) {
      const apiKey = CONFIG.apiKey;
      const auth = String(req.headers['authorization'] || '');
      const match = auth.match(/^Bearer\s+(.+)$/i);
      if (!match || !timingSafeCompare(match[1], apiKey)) {
        return res.status(403).json({ error: 'Forbidden' });
      }
    } else {
      const remoteAddress = req.socket?.remoteAddress || '';
      const allowUnauthedLocal = CONFIG.nodeEnv !== 'production' && isLoopbackAddress(remoteAddress);
      if (!allowUnauthedLocal) {
        return res.status(403).json({
          error:
            'Cookie import is disabled without CAMOFOX_API_KEY except for loopback requests in non-production environments.',
        });
      }
    }

    const userId = req.params.userId;
    if (!req.body || !('cookies' in req.body)) {
      return res.status(400).json({ error: 'Missing "cookies" field in request body' });
    }
    const cookies = req.body.cookies;
    if (!Array.isArray(cookies)) {
      return res.status(400).json({ error: 'cookies must be an array' });
    }

    if (cookies.length > 500) {
      return res.status(400).json({ error: 'Too many cookies. Maximum 500 per request.' });
    }

    const invalid = [];
    for (let i = 0; i < cookies.length; i++) {
      const c = cookies[i];
      const missing = [];
      if (!c || typeof c !== 'object') {
        invalid.push({ index: i, error: 'cookie must be an object' });
        continue;
      }
      if (typeof c.name !== 'string' || !c.name) missing.push('name');
      if (typeof c.value !== 'string') missing.push('value');
      if (typeof c.domain !== 'string' || !c.domain) missing.push('domain');
      if (missing.length) invalid.push({ index: i, missing });
    }
    if (invalid.length) {
      return res.status(400).json({
        error: 'Invalid cookie objects: each cookie must include name, value, and domain',
        invalid,
      });
    }

    const allowedFields = ['name', 'value', 'domain', 'path', 'expires', 'httpOnly', 'secure', 'sameSite'];
    const sanitized = cookies.map(c => {
      const clean = {};
      for (const k of allowedFields) {
        if (c[k] !== undefined) clean[k] = c[k];
      }
      return clean;
    });

    const session = await getSession(userId);
    await session.context.addCookies(sanitized);
    const result = { ok: true, userId: String(userId), count: sanitized.length };
    log('info', 'cookies imported', { reqId: req.reqId, userId: String(userId), count: sanitized.length });
    pluginEvents.emit('session:cookies:import', { userId: String(userId), count: sanitized.length });
    res.json(result);
  } catch (err) {
    failuresTotal.labels(classifyError(err), 'set_cookies').inc();
    log('error', 'cookie import failed', { reqId: req.reqId, error: err.message });
    res.status(500).json({ error: safeError(err) });
  }
});

let browser = null;
let _lastBrowserPid = null; // Track PID independently for force-kill after close
let _browserClosePromise = null; // Shared promise for concurrent close serialization
// userId -> { context, tabGroups: Map<sessionKey, Map<tabId, TabState>>, lastAccess }
// TabState = { page, refs: Map<refId, {role, name, nth}>, visitedUrls: Set, downloads: Array, toolCalls: number }
// Note: sessionKey was previously called listItemId - both are accepted for backward compatibility
const sessions = new Map();

const SESSION_TIMEOUT_MS = CONFIG.sessionTimeoutMs;
const MAX_SNAPSHOT_NODES = 500;
const TAB_INACTIVITY_MS = CONFIG.tabInactivityMs;
const MAX_SESSIONS = CONFIG.maxSessions;
const MAX_TABS_PER_SESSION = CONFIG.maxTabsPerSession;
const MAX_TABS_GLOBAL = CONFIG.maxTabsGlobal;
const HANDLER_TIMEOUT_MS = CONFIG.handlerTimeoutMs;
const MAX_CONCURRENT_PER_USER = CONFIG.maxConcurrentPerUser;
const PAGE_CLOSE_TIMEOUT_MS = 5000;
const NAVIGATE_TIMEOUT_MS = CONFIG.navigateTimeoutMs;
const BUILDREFS_TIMEOUT_MS = CONFIG.buildrefsTimeoutMs;
const NATIVE_MEM_RESTART_THRESHOLD_MB = CONFIG.nativeMemRestartThresholdMb;
let _nativeMemBaseline = null; // RSS - heapUsed at first idle measurement
const FAILURE_THRESHOLD = 3;
const MAX_CONSECUTIVE_TIMEOUTS = 3;
const TAB_LOCK_TIMEOUT_MS = 35000; // Must be > HANDLER_TIMEOUT_MS so active op times out first



// Proper mutex for tab serialization. The old Promise-chain lock on timeout proceeded
// WITHOUT the lock, allowing concurrent Playwright operations that corrupt CDP state.
class TabLock {
  constructor() {
    this.queue = [];
    this.active = false;
  }

  acquire(timeoutMs) {
    return new Promise((resolve, reject) => {
      const entry = { resolve, reject, timer: null };
      entry.timer = setTimeout(() => {
        const idx = this.queue.indexOf(entry);
        if (idx !== -1) this.queue.splice(idx, 1);
        tabLockTimeoutsTotal.inc();
        refreshTabLockQueueDepth();
        reject(new Error('Tab lock queue timeout'));
      }, timeoutMs);
      this.queue.push(entry);
      refreshTabLockQueueDepth();
      this._tryNext();
    });
  }

  release() {
    this.active = false;
    this._tryNext();
    refreshTabLockQueueDepth();
  }

  _tryNext() {
    if (this.active || this.queue.length === 0) return;
    this.active = true;
    const entry = this.queue.shift();
    clearTimeout(entry.timer);
    refreshTabLockQueueDepth();
    entry.resolve();
  }

  drain() {
    this.active = true;
    for (const entry of this.queue) {
      clearTimeout(entry.timer);
      entry.reject(new Error('Tab destroyed'));
    }
    this.queue = [];
    refreshTabLockQueueDepth();
  }
}

// Per-tab locks to serialize operations on the same tab
const tabLocks = new Map(); // tabId -> TabLock

function getTabLock(tabId) {
  if (!tabLocks.has(tabId)) tabLocks.set(tabId, new TabLock());
  return tabLocks.get(tabId);
}

// Timeout is INSIDE the lock so each operation gets its full budget
// regardless of how long it waited in the queue.
async function withTabLock(tabId, operation, timeoutMs = HANDLER_TIMEOUT_MS) {
  const lock = getTabLock(tabId);
  await lock.acquire(TAB_LOCK_TIMEOUT_MS);
  try {
    return await withTimeout(operation(), timeoutMs, 'action');
  } finally {
    lock.release();
  }
}

function withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms)
    )
  ]);
}

function requestTimeoutMs(baseMs = HANDLER_TIMEOUT_MS) {
  return proxyPool?.canRotateSessions ? Math.max(baseMs, 180000) : baseMs;
}

const userConcurrency = new Map();

async function withUserLimit(userId, operation) {
  const key = normalizeUserId(userId);
  let state = userConcurrency.get(key);
  if (!state) {
    state = { active: 0, queue: [] };
    userConcurrency.set(key, state);
  }
  if (state.active >= MAX_CONCURRENT_PER_USER) {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('User concurrency limit reached, try again')), 30000);
      state.queue.push(() => { clearTimeout(timer); resolve(); });
    });
  }
  state.active++;
  healthState.activeOps++;
  try {
    const result = await operation();
    healthState.lastSuccessfulNav = Date.now();
    return result;
  } finally {
    healthState.activeOps--;
    state.active--;
    if (state.queue.length > 0) {
      const next = state.queue.shift();
      next();
    }
    if (state.active === 0 && state.queue.length === 0) {
      userConcurrency.delete(key);
    }
  }
}

async function safePageClose(page) {
  try {
    await Promise.race([
      page.close(),
      new Promise(resolve => setTimeout(resolve, PAGE_CLOSE_TIMEOUT_MS))
    ]);
  } catch (e) {
    log('warn', 'page close failed', { error: e.message });
  }
}

// Detect host OS for fingerprint generation
function getHostOS() {
  const platform = os.platform();
  if (platform === 'darwin') return 'macos';
  if (platform === 'win32') return 'windows';
  return 'linux';
}

// Proxy strategy for outbound browsing.
const proxyPool = createProxyPool(CONFIG.proxy);

if (proxyPool) {
  log('info', 'proxy pool created', {
    mode: proxyPool.mode,
    host: proxyPool.canRotateSessions ? CONFIG.proxy.backconnectHost : CONFIG.proxy.host,
    ports: proxyPool.canRotateSessions ? [CONFIG.proxy.backconnectPort] : CONFIG.proxy.ports,
    poolSize: proxyPool.size,
    country: CONFIG.proxy.country || null,
    state: CONFIG.proxy.state || null,
    city: CONFIG.proxy.city || null,
  });
} else {
  log('info', 'no proxy configured');
}

const BROWSER_IDLE_TIMEOUT_MS = CONFIG.browserIdleTimeoutMs;
let browserIdleTimer = null;
let browserLaunchPromise = null;
let browserWarmRetryTimer = null;

function scheduleBrowserIdleShutdown() {
  clearBrowserIdleTimer();
  if (sessions.size === 0 && browser) {
    browserIdleTimer = setTimeout(async () => {
      if (sessions.size === 0 && browser) {
        log('info', 'browser idle shutdown (no sessions)');
        await closeBrowserFully('idle_shutdown');
      }
    }, BROWSER_IDLE_TIMEOUT_MS);
  }
}

function clearBrowserIdleTimer() {
  if (browserIdleTimer) {
    clearTimeout(browserIdleTimer);
    browserIdleTimer = null;
  }
}

// Detects errors that retrying cannot recover from (e.g., Camoufox binary
// missing because postinstall was skipped). The user must run
// `npx camoufox-js fetch` and restart; looping on this wastes resources
// and buries the actionable error under noise.
//
// Sentinel: matches the human-readable message thrown by camoufox-js's
// FileNotFoundError in dist/pkgman.js (Version.fromPath). FileNotFoundError
// is not exported from the public API, so substring matching is the only
// available hook. If the upstream message changes, this regex needs an
// update; the dependency range in package.json controls exposure.
function isFatalInstallError(err) {
  return /Version information not found/i.test(err?.message || '');
}

function scheduleBrowserWarmRetry(delayMs = 5000) {
  if (browserWarmRetryTimer || browser || browserLaunchPromise) return;
  browserWarmRetryTimer = setTimeout(async () => {
    browserWarmRetryTimer = null;
    try {
      const start = Date.now();
      await ensureBrowser();
      log('info', 'background browser warm retry succeeded', { ms: Date.now() - start });
    } catch (err) {
      if (isFatalInstallError(err)) {
        log('error', 'browser unavailable: Camoufox binaries are not installed; aborting retry loop', {
          error: err.message,
          remediation: 'run `npx camoufox-js fetch` then restart the server',
        });
        return;
      }
      log('warn', 'background browser warm retry failed', { error: err.message, nextDelayMs: delayMs });
      scheduleBrowserWarmRetry(Math.min(delayMs * 2, 30000));
    }
  }, delayMs);
}

// --- Browser health tracking ---
const healthState = {
  consecutiveNavFailures: 0,
  lastSuccessfulNav: Date.now(),
  isRecovering: false,
  activeOps: 0,
};

function recordNavSuccess() {
  healthState.consecutiveNavFailures = 0;
  healthState.lastSuccessfulNav = Date.now();
}

function recordNavFailure() {
  healthState.consecutiveNavFailures++;
  return healthState.consecutiveNavFailures >= FAILURE_THRESHOLD;
}

async function restartBrowser(reason) {
  if (healthState.isRecovering) return;
  healthState.isRecovering = true;
  browserRestartsTotal.labels(reason).inc();
  log('error', 'restarting browser', { reason, failures: healthState.consecutiveNavFailures });
  pluginEvents.emit('browser:restart', { reason });
  try {
    await closeAllSessions(`browser_restart:${reason}`, { clearDownloads: true, clearLocks: true });
    await closeBrowserFully(`browser_restart:${reason}`);
    pluginEvents.emit('browser:closed', { reason });
    browserLaunchPromise = null;
    await ensureBrowser();
    healthState.consecutiveNavFailures = 0;
    healthState.lastSuccessfulNav = Date.now();
    log('info', 'browser restarted successfully');
  } catch (err) {
    log('error', 'browser restart failed', { error: err.message });
  } finally {
    healthState.isRecovering = false;
  }
}

function getTotalTabCount() {
  let total = 0;
  for (const session of sessions.values()) {
    for (const group of session.tabGroups.values()) {
      total += group.size;
    }
  }
  return total;
}

// Virtual display for WebGL support and anti-detection.
// Xvfb gives Firefox a real X display with GLX, enabling software-rendered WebGL
// via Mesa llvmpipe. Without this, WebGL returns "no context" -- a massive bot signal.
let virtualDisplay = null;
let browserLaunchProxy = null;

async function probeGoogleSearch(candidateBrowser) {
  let context = null;
  try {
    context = await candidateBrowser.newContext({
      viewport: { width: 1280, height: 720 },
      permissions: ['geolocation'],
    });
    const page = await context.newPage();
    await page.goto('https://www.google.com/', { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(1200);
    await page.goto('https://www.google.com/search?q=weather%20today', { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(4000);

    const blocked = await isGoogleSearchBlocked(page);
    return {
      ok: !blocked && isGoogleSerp(page.url()),
      url: page.url(),
      blocked,
    };
  } finally {
    await context?.close().catch(() => {});
  }
}

function attachBrowserCleanup(candidateBrowser, localVirtualDisplay) {
  const origClose = candidateBrowser.close.bind(candidateBrowser);
  candidateBrowser.close = async (...args) => {
    await origClose(...args);
    browserLaunchProxy = null;
    if (localVirtualDisplay) {
      localVirtualDisplay.kill();
      if (virtualDisplay === localVirtualDisplay) virtualDisplay = null;
    }
  };
}

/**
 * Close browser with full process-tree cleanup. Handles the race where
 * browser.close() fails/hangs but process tree survives.
 *
 * Serialized: concurrent callers await the same promise (no double-close).
 *
 * Order: capture PID -> close browser -> force-kill survivors ->
 * clean temp profiles -> verify FD/handle drop.
 */
async function closeBrowserFully(reason) {
  if (_browserClosePromise) return _browserClosePromise;
  _browserClosePromise = _closeBrowserFullyImpl(reason);
  try {
    return await _browserClosePromise;
  } finally {
    _browserClosePromise = null;
  }
}

async function _closeBrowserFullyImpl(reason) {
  const b = browser;
  if (!b) return;

  // Capture PID before nulling browser ref -- we need it for force-kill
  const pid = _lastBrowserPid;
  const preCloseFds = _countOpenFds();
  const preCloseHandles = _countActiveHandles();

  // Null the ref so new requests don't use a dying browser
  browser = null;
  _lastBrowserPid = null;

  // Close through Playwright (sends CDP Browser.close, then SIGKILL process group)
  let closeTimer;
  try {
    await Promise.race([
      b.close(),
      new Promise((_, reject) => { closeTimer = setTimeout(() => reject(new Error('browser.close() timeout')), 10000); }),
    ]);
  } catch (err) {
    log('warn', 'browser.close() failed or timed out', { reason, error: err.message, pid });
  } finally {
    clearTimeout(closeTimer);
  }

  // Force-kill the entire process tree if any survivors
  if (pid) {
    await _forceKillProcessTree(pid, reason);
  }

  // Clean up stale Firefox temp profiles (enable_cache: true accumulates data)
  try {
    const cleaned = cleanupStaleFirefoxProfiles();
    if (cleaned.removed > 0) {
      log('info', 'cleaned stale firefox profiles after browser close', cleaned);
    }
  } catch { /* best effort */ }

  // Reset native memory baseline so next browser measures from fresh
  reporter.resetNativeMemBaseline();
  _nativeMemBaseline = null;

  // Verify cleanup: check FD/handle counts dropped (after force-kill completes)
  const postCloseFds = _countOpenFds();
  const postCloseHandles = _countActiveHandles();
  if (postCloseFds !== null && preCloseFds !== null) {
    const fdDelta = postCloseFds - preCloseFds;
    // After close we expect fewer FDs. If more leaked, warn.
    if (fdDelta > 10) {
      log('warn', 'FD leak detected after browser close', {
        reason, preCloseFds, postCloseFds, delta: fdDelta,
        preCloseHandles, postCloseHandles,
      });
    }
  }
  log('info', 'browser closed fully', {
    reason, pid, preCloseFds, postCloseFds, preCloseHandles, postCloseHandles,
  });
}

/**
 * Force-kill a browser process tree by PID. On Linux, kills the process group
 * (SIGKILL -pid) then scans /proc for any orphaned children.
 */
async function _forceKillProcessTree(pid, reason) {
  if (!pid || pid <= 1) return;

  // Kill the specific browser process first (positive PID = single process)
  try {
    process.kill(pid, 'SIGKILL');
    log('info', 'sent SIGKILL to browser process', { pid, reason });
  } catch (err) {
    if (err.code !== 'ESRCH') {
      log('warn', 'failed to kill browser process', { pid, error: err.message });
    }
  }

  // Then try the process group (Playwright launches with detached:true on Linux,
  // making the browser a process group leader)
  try {
    process.kill(-pid, 'SIGKILL');
  } catch {
    // ESRCH = group doesn't exist (browser wasn't a group leader), which is fine
  }

  // Wait for kernel to reparent children to PID 1 before scanning
  await new Promise(r => setTimeout(r, 200));

  // On Linux: scan /proc for orphaned children that escaped the process group
  // (reparented to PID 1 by init/systemd, common with Firefox content processes).
  // Also checks PPid === Node PID for containerized environments without init.
  if (process.platform === 'linux') {
    const myPid = process.pid;
    // Snapshot the current browser PID to avoid killing a newly launched browser
    const currentBrowserPid = _lastBrowserPid;
    try {
      const procDirs = fs.readdirSync('/proc').filter(d => /^\d+$/.test(d));
      const orphans = [];
      for (const procPid of procDirs) {
        const numPid = parseInt(procPid);
        // Never kill ourselves, the old PID (already killed), or the new browser
        if (numPid === myPid || numPid === pid || numPid === currentBrowserPid) continue;
        try {
          const status = fs.readFileSync(`/proc/${procPid}/status`, 'utf8');
          const ppidMatch = status.match(/PPid:\s+(\d+)/);
          const ppid = ppidMatch ? parseInt(ppidMatch[1]) : -1;
          // Orphaned to init (PID 1) or reparented to us (Node is PID 1 in containers)
          if (ppid === 1 || ppid === myPid) {
            const cmdline = fs.readFileSync(`/proc/${procPid}/cmdline`, 'utf8');
            // Firefox-specific: binary name or Gecko child process marker
            if (/firefox-esr|firefox|camoufox|libxul\.so|GeckoChildProcess/i.test(cmdline)) {
              orphans.push(numPid);
            }
          }
        } catch { /* process vanished or permission denied */ }
      }
      if (orphans.length > 0) {
        log('warn', 'killing orphaned browser child processes', { orphans, reason });
        for (const orphanPid of orphans) {
          try { process.kill(orphanPid, 'SIGKILL'); } catch { /* already dead */ }
        }
      }
    } catch (err) {
      log('warn', 'failed to scan for orphaned browser processes', { error: err.message });
    }
  }

  // Give the OS a moment to reclaim resources
  await new Promise(r => setTimeout(r, 300));
}

function _countOpenFds() {
  try {
    if (process.platform === 'linux') return fs.readdirSync('/proc/self/fd').length;
  } catch { /* unavailable */ }
  return null;
}

function _countActiveHandles() {
  try { return process._getActiveHandles().length; } catch { return null; }
}

async function launchBrowserInstance() {
  const hostOS = getHostOS();
  const maxAttempts = proxyPool?.launchRetries ?? 1;
  let lastError = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const launchProxy = proxyPool
      ? proxyPool.getLaunchProxy(proxyPool.canRotateSessions ? `browser-${crypto.randomUUID().replace(/-/g, '').slice(0, 12)}` : undefined)
      : null;

    let localVirtualDisplay = null;
    let vdDisplay = undefined;
    let candidateBrowser = null;

    try {
      if (os.platform() === 'linux') {
        localVirtualDisplay = pluginCtx.createVirtualDisplay();
        vdDisplay = localVirtualDisplay.get();
        log('info', 'xvfb virtual display started', { display: vdDisplay, attempt });
      }
    } catch (err) {
      log('warn', 'xvfb not available, falling back to headless', { error: err.message, attempt });
      localVirtualDisplay = null;
    }

    const useVirtualDisplay = !!vdDisplay;
    log('info', 'launching camoufox', {
      hostOS,
      attempt,
      maxAttempts,
      geoip: !!launchProxy,
      proxyMode: proxyPool?.mode || null,
      proxyServer: launchProxy?.server || null,
      proxySession: launchProxy?.sessionId || null,
      proxyPoolSize: proxyPool?.size || 0,
      virtualDisplay: useVirtualDisplay,
    });

    try {
      const options = await launchOptions({
        headless: useVirtualDisplay ? false : true,
        os: hostOS,
        humanize: true,
        enable_cache: true,
        proxy: launchProxy,
        geoip: !!launchProxy,
        virtual_display: vdDisplay,
      });
      options.proxy = normalizePlaywrightProxy(options.proxy);
      await pluginEvents.emitAsync('browser:launching', { options });

      candidateBrowser = await firefox.launch(options);

      if (proxyPool?.canRotateSessions) {
        const probe = await probeGoogleSearch(candidateBrowser);
        if (!probe.ok) {
          log('warn', 'browser launch google probe failed', {
            attempt,
            maxAttempts,
            proxySession: launchProxy?.sessionId || null,
            url: probe.url,
          });
          if (attempt < maxAttempts) {
            await candidateBrowser.close().catch(() => {});
            if (localVirtualDisplay) localVirtualDisplay.kill();
            continue;
          }
          // Last attempt: accept browser in degraded mode rather than death-spiraling.
          // Non-Google sites will still work; Google requests will get blocked responses.
          log('error', 'all proxy sessions Google-blocked, accepting browser in degraded mode', {
            maxAttempts,
            proxySession: launchProxy?.sessionId || null,
          });
        }
      }

      virtualDisplay = localVirtualDisplay;
      browserLaunchProxy = launchProxy;
      _lastBrowserPid = candidateBrowser.process?.()?.pid ?? null;
      browser = candidateBrowser; // publish AFTER PID is captured
      attachBrowserCleanup(browser, localVirtualDisplay);
      pluginEvents.emit('browser:launched', { browser, display: vdDisplay });

      log('info', 'camoufox launched', {
        attempt,
        maxAttempts,
        virtualDisplay: useVirtualDisplay,
        proxyMode: proxyPool?.mode || null,
        proxyServer: launchProxy?.server || null,
        proxySession: launchProxy?.sessionId || null,
      });
      return browser;
    } catch (err) {
      lastError = err;
      log('warn', 'camoufox launch attempt failed', {
        attempt,
        maxAttempts,
        error: err.message,
        proxySession: launchProxy?.sessionId || null,
      });
      await candidateBrowser?.close().catch(() => {});
      if (localVirtualDisplay) localVirtualDisplay.kill();
    }
  }

  throw lastError || new Error('Failed to launch a usable browser');
}

async function ensureBrowser() {
  clearBrowserIdleTimer();
  if (browser && !browser.isConnected()) {
    failuresTotal.labels('browser_disconnected', 'internal').inc();
    log('warn', 'browser disconnected, clearing dead sessions and relaunching', {
      deadSessions: sessions.size,
    });
    await closeAllSessions('browser_disconnected', { clearDownloads: true, clearLocks: true });
    await closeBrowserFully('browser_disconnected');
  }
  if (browser) return browser;
  if (browserLaunchPromise) return browserLaunchPromise;
  const launchTimeoutMs = proxyPool?.launchTimeoutMs ?? 60000;
  browserLaunchPromise = Promise.race([
    launchBrowserInstance(),
    new Promise((_, reject) => setTimeout(() => reject(new Error(`Browser launch timeout (${Math.round(launchTimeoutMs / 1000)}s)`)), launchTimeoutMs)),
  ]).finally(() => { browserLaunchPromise = null; });
  return browserLaunchPromise;
}

// Helper to normalize userId to string (JSON body may parse as number)
function normalizeUserId(userId) {
  return String(userId);
}

const sessionCreations = new Map();

function clearSessionLocks(session) {
  if (!session?.tabGroups) return;
  for (const [, group] of session.tabGroups) {
    for (const tabId of group.keys()) {
      const lock = tabLocks.get(tabId);
      if (lock) {
        lock.drain();
        tabLocks.delete(tabId);
      }
    }
  }
  refreshTabLockQueueDepth();
}

async function closeSession(userId, session, {
  reason = 'session_closed',
  clearDownloads = true,
  clearLocks = true,
} = {}) {
  if (!session) return;

  const key = normalizeUserId(userId);

  if (clearDownloads) {
    await clearSessionDownloads(session).catch(() => {});
  }

  await pluginEvents.emitAsync('session:destroying', { userId: key, reason });
  if (session.tracePath) {
    try {
      await session.context.tracing.stop({ path: session.tracePath });
      log('info', 'tracing saved', { userId: key, path: session.tracePath });
    } catch (err) {
      log('warn', 'tracing.stop failed', { userId: key, error: err.message });
    }
  }

  await session.context.close().catch(() => {});
  sessions.delete(key);
  await pluginEvents.emitAsync('session:destroyed', { userId: key, reason });

  if (clearLocks) {
    clearSessionLocks(session);
  }

  refreshActiveTabsGauge();
}

async function closeAllSessions(reason, { clearDownloads = true, clearLocks = true } = {}) {
  const openSessions = Array.from(sessions.entries());
  for (const [userId, session] of openSessions) {
    await closeSession(userId, session, { reason, clearDownloads, clearLocks });
  }
}

async function getSession(userId, { trace = false } = {}) {
  const key = normalizeUserId(userId);
  let session = sessions.get(key);
  
  // Check if existing session's context is still alive
  if (session) {
    if (session._closing) {
      // Session is being torn down by reaper/expiry -- treat as dead
      session = null;
    } else {
      try {
        // Lightweight probe: pages() is synchronous-ish and throws if context is dead
        session.context.pages();
      } catch (err) {
        log('warn', 'session context dead, recreating', { userId: key, error: err.message });
        await closeSession(key, session, { reason: 'dead_context', clearDownloads: true, clearLocks: true });
        session = null;
      }
    }
  }
  
  if (!session) {
    session = await coalesceInflight(sessionCreations, key, async () => {
      if (sessions.size >= MAX_SESSIONS) {
        throw new Error('Maximum concurrent sessions reached');
      }
      const b = await ensureBrowser();
      const contextOptions = {
        viewport: { width: 1280, height: 720 },
        permissions: ['geolocation'],
      };
      // When geoip is active (proxy configured), camoufox auto-configures
      // locale/timezone/geolocation from the proxy IP. Without proxy, use defaults.
      if (!CONFIG.proxy.host) {
        contextOptions.locale = 'en-US';
        contextOptions.timezoneId = 'America/Los_Angeles';
        contextOptions.geolocation = { latitude: 37.7749, longitude: -122.4194 };
      }
      let sessionProxy = null;
      if (proxyPool?.canRotateSessions) {
        sessionProxy = proxyPool.getNext(`ctx-${key}-${crypto.randomUUID().replace(/-/g, '').slice(0, 8)}`);
        contextOptions.proxy = normalizePlaywrightProxy(sessionProxy);
        log('info', 'session proxy assigned', { userId: key, sessionId: sessionProxy.sessionId });
      } else if (proxyPool) {
        sessionProxy = proxyPool.getNext();
        contextOptions.proxy = normalizePlaywrightProxy(sessionProxy);
        log('info', 'session proxy assigned', { userId: key, proxy: sessionProxy.server });
      }
      await pluginEvents.emitAsync('session:creating', { userId: key, contextOptions });
      const context = await b.newContext(contextOptions);

      let tracePath = null;
      if (trace) {
        const traceDir = ensureTracesDir(CONFIG.tracesDir, key);
        tracePath = tracePathFor(CONFIG.tracesDir, key, makeTraceFilename());
        try {
          await context.tracing.start({ screenshots: true, snapshots: true, sources: false });
          log('info', 'tracing enabled for session', { userId: key, traceDir, tracePath });
        } catch (err) {
          log('warn', 'tracing.start failed; session will not be traced', { userId: key, error: err.message });
          tracePath = null;
        }
      }

      const created = { context, tabGroups: new Map(), lastAccess: Date.now(), proxySessionId: sessionProxy?.sessionId || null, tracePath };
      sessions.set(key, created);
      await pluginEvents.emitAsync('session:created', { userId: key, context });
      log('info', 'session created', {
        userId: key,
        proxyMode: proxyPool?.mode || null,
        proxyServer: sessionProxy?.server || browserLaunchProxy?.server || null,
        proxySession: sessionProxy?.sessionId || browserLaunchProxy?.sessionId || null,
      });
      return created;
    });
  }
  session.lastAccess = Date.now();
  return session;
}

function getTabGroup(session, listItemId) {
  let group = session.tabGroups.get(listItemId);
  if (!group) {
    group = new Map();
    session.tabGroups.set(listItemId, group);
  }
  return group;
}

function isDeadContextError(err) {
  const msg = err && err.message || '';
  return msg.includes('Target page, context or browser has been closed') ||
         msg.includes('browser has been closed') ||
         msg.includes('Context closed') ||
         msg.includes('Browser closed');
}

function isTimeoutError(err) {
  const msg = err && err.message || '';
  return msg.includes('timed out after') ||
         (msg.includes('Timeout') && msg.includes('exceeded'));
}

function isTabLockQueueTimeout(err) {
  return err && err.message === 'Tab lock queue timeout';
}

function isTabDestroyedError(err) {
  return err && err.message === 'Tab destroyed';
}

// Centralized error handler for route catch blocks.
// Auto-destroys dead browser sessions and returns appropriate status codes.
function isProxyError(err) {
  if (!err) return false;
  const msg = err.message || '';
  return msg.includes('NS_ERROR_PROXY') || msg.includes('proxy connection') || msg.includes('Proxy connection');
}

function handleRouteError(err, req, res, extraFields = {}) {
  const failureType = classifyError(err);
  const action = actionFromReq(req);
  failuresTotal.labels(failureType, action).inc();

  const userId = req.body?.userId || req.query?.userId;
  const tabId = req.body?.tabId || req.query?.tabId || req.params?.tabId;
  if (tabId) {
    pluginEvents.emit('tab:error', { userId, tabId, error: err });
  }
  if (userId && isDeadContextError(err)) {
    destroySession(userId);
  }
  // Proxy errors mean the session is dead -- rotate at context level.
  // Destroy the user's session so the next request gets a fresh context with a new proxy.
  if (isProxyError(err) && proxyPool?.canRotateSessions && userId) {
    log('warn', 'proxy error detected, destroying user session for fresh proxy on next request', {
      action, userId, error: err.message,
    });
    browserRestartsTotal.labels('proxy_error').inc();
    destroySession(userId);
  }
  // Track consecutive timeouts per tab and auto-destroy stuck tabs
  if (userId && isTimeoutError(err)) {
    const tabId = req.body?.tabId || req.query?.tabId || req.params?.tabId;
    const session = sessions.get(normalizeUserId(userId));
    if (session && tabId) {
      const found = findTab(session, tabId);
      if (found) {
        found.tabState.consecutiveTimeouts++;
        if (found.tabState.consecutiveTimeouts >= MAX_CONSECUTIVE_TIMEOUTS) {
          log('warn', 'auto-destroying tab after consecutive timeouts', { tabId, count: found.tabState.consecutiveTimeouts });
          destroyTab(session, tabId, 'consecutive_timeouts', userId);
        }
      }
    }
  }
  // Lock queue timeout = tab is stuck. Destroy immediately.
  if (userId && isTabLockQueueTimeout(err)) {
    const session = sessions.get(normalizeUserId(userId));
    if (session && tabId) {
      destroyTab(session, tabId, 'lock_queue', userId);
    }
    return res.status(503).json({ error: 'Tab unresponsive and has been destroyed. Open a new tab.', ...extraFields });
  }
  // Tab was destroyed while this request was queued in the lock
  if (isTabDestroyedError(err)) {
    return res.status(410).json({ error: 'Tab was destroyed. Open a new tab.', ...extraFields });
  }
  // --- Frustration detection: report when a tab hits a streak of failures ---
  // Individual failures are noise. 3+ consecutive = the site is persistently broken.
  const FRUSTRATION_TYPES = new Set(['timeout', 'dead_context', 'nav_aborted']);
  if (FRUSTRATION_TYPES.has(failureType) && userId && tabId) {
    const session = sessions.get(normalizeUserId(userId));
    const found = session && findTab(session, tabId);
    if (found) {
      const ts = found.tabState;
      ts.consecutiveFailures = (ts.consecutiveFailures || 0) + 1;
      if (!ts.failureJournal) ts.failureJournal = [];
      ts.failureJournal.push({ type: failureType, action, at: Date.now() });
      if (ts.failureJournal.length > 20) ts.failureJournal = ts.failureJournal.slice(-20);

      if (ts.consecutiveFailures === 3) {
        const _proxyErr = classifyProxyError(err?.message);
        reporter.reportHang(action, req.startTime ? Date.now() - req.startTime : 0, {
          error: err,
          healthSnapshot: ts.healthTracker ? ts.healthTracker.snapshot() : undefined,
          healthTracker: ts.healthTracker || null,
          resourceOpts: _resourceOpts(),
          proxy: proxyPool ? {
            configured: true,
            type: proxyPool.mode || null,
            authConfigured: !!CONFIG.proxy?.username,
            error: _proxyErr.proxyError,
            tlsError: _proxyErr.proxyTlsError,
          } : { configured: false },
          context: {
            failureType,
            consecutiveFailures: ts.consecutiveFailures,
            toolCalls: ts.toolCalls,
            journal: ts.failureJournal.map(j => `${j.type}:${j.action}`),
          },
        });
      }
    }
  }
  sendError(res, err, extraFields);
}

function destroyTab(session, tabId, reason, userId) {
  const lock = tabLocks.get(tabId);
  if (lock) {
    lock.drain();
    tabLocks.delete(tabId);
    refreshTabLockQueueDepth();
  }
  for (const [listItemId, group] of session.tabGroups) {
    if (group.has(tabId)) {
      const tabState = group.get(tabId);
      log('warn', 'destroying stuck tab', { tabId, listItemId, toolCalls: tabState.toolCalls, reason: reason || 'unknown' });
      safePageClose(tabState.page);
      group.delete(tabId);
      if (group.size === 0) session.tabGroups.delete(listItemId);
      refreshActiveTabsGauge();
      if (reason) tabsDestroyedTotal.labels(reason).inc();
      pluginEvents.emit('tab:destroyed', { userId: userId || null, tabId, reason: reason || 'unknown' });
      return true;
    }
  }
  return false;
}

/**
 * Recycle the oldest (least-used) tab in a session to free a slot.
 * Closes the old tab's page and removes it from its group.
 * Returns { recycledTabId, recycledFromGroup } or null if no tab to recycle.
 */
async function recycleOldestTab(session, reqId, userId) {
  let oldestTab = null;
  let oldestGroup = null;
  let oldestGroupKey = null;
  let oldestTabId = null;
  for (const [gKey, group] of session.tabGroups) {
    for (const [tid, ts] of group) {
      if (!oldestTab || ts.toolCalls < oldestTab.toolCalls) {
        oldestTab = ts;
        oldestGroup = group;
        oldestGroupKey = gKey;
        oldestTabId = tid;
      }
    }
  }
  if (!oldestTab) return null;

  await safePageClose(oldestTab.page);
  oldestGroup.delete(oldestTabId);
  if (oldestGroup.size === 0) session.tabGroups.delete(oldestGroupKey);
  const lock = tabLocks.get(oldestTabId);
  if (lock) { lock.drain(); tabLocks.delete(oldestTabId); }
  refreshTabLockQueueDepth();
  tabsRecycledTotal.inc();
  pluginEvents.emit('tab:recycled', { userId: userId || null, tabId: oldestTabId });
  log('info', 'tab recycled (limit reached)', { reqId, recycledTabId: oldestTabId, recycledFromGroup: oldestGroupKey });
  return { recycledTabId: oldestTabId, recycledFromGroup: oldestGroupKey };
}

function destroySession(userId) {
  const key = normalizeUserId(userId);
  const session = sessions.get(key);
  if (!session) return;
  log('warn', 'destroying dead session', { userId: key });
  sessions.delete(key);
  closeSession(key, session, { reason: 'destroy_session', clearDownloads: true, clearLocks: true }).catch(() => {});
}

function findTab(session, tabId) {
  for (const [listItemId, group] of session.tabGroups) {
    if (group.has(tabId)) {
      const tabState = group.get(tabId);
      return { tabState, listItemId, group };
    }
  }
  return null;
}

function createTabState(page) {
  const healthTracker = createTabHealthTracker(page);
  return {
    page,
    refs: new Map(),
    visitedUrls: new Set(),
    downloads: [],
    toolCalls: 0,
    consecutiveTimeouts: 0,
    consecutiveFailures: 0,
    failureJournal: [],
    healthTracker,
    lastSnapshot: null,
    lastRequestedUrl: null,
    googleRetryCount: 0,
    navigateAbort: null,
  };
}

async function isGoogleUnavailable(page) {
  if (!page || page.isClosed()) return false;
  const bodyText = await page.evaluate(() => document.body?.innerText?.slice(0, 600) || '').catch(() => '');
  return /Unable to connect|502 Bad Gateway or Proxy Error|Camoufox can't establish a connection/.test(bodyText);
}

async function rotateGoogleTab(userId, sessionKey, tabId, previousTabState, reason, reqId) {
  if (!previousTabState?.lastRequestedUrl || !isGoogleSearchUrl(previousTabState.lastRequestedUrl)) return null;
  if ((previousTabState.googleRetryCount || 0) >= 3) return null;

  browserRestartsTotal.labels(reason).inc(); // track rotation events (not a full restart)

  // Rotate at context level -- create a fresh context with a new proxy session
  // instead of restarting the entire browser (which kills ALL sessions/tabs).
  const key = normalizeUserId(userId);
  const oldSession = sessions.get(key);
  if (oldSession) {
    await closeSession(key, oldSession, { reason: 'google_rotate_context', clearDownloads: true, clearLocks: true });
  }
  const session = await getSession(userId);
  const group = getTabGroup(session, sessionKey);
  const page = await session.context.newPage();
  const tabState = createTabState(page);
  tabState.googleRetryCount = (previousTabState.googleRetryCount || 0) + 1;
  tabState.lastRequestedUrl = previousTabState.lastRequestedUrl;
  attachDownloadListener(tabState, tabId, log, pluginEvents, userId);
  group.set(tabId, tabState);
  refreshActiveTabsGauge();

  log('warn', 'replaying google search on fresh context (per-context proxy rotation)', {
    reqId,
    tabId,
    retryCount: tabState.googleRetryCount,
    url: tabState.lastRequestedUrl,
    proxySession: session.proxySessionId || null,
  });

  await withPageLoadDuration('navigate', () => page.goto('https://www.google.com/', { waitUntil: 'domcontentloaded', timeout: 30000 }));
  tabState.visitedUrls.add('https://www.google.com/');
  await page.waitForTimeout(1200);
  await withPageLoadDuration('navigate', () => page.goto(tabState.lastRequestedUrl, { waitUntil: 'domcontentloaded', timeout: 30000 }));
  tabState.visitedUrls.add(tabState.lastRequestedUrl);
  return { session, tabState };
}

function refreshActiveTabsGauge() {
  activeTabsGauge.set(getTotalTabCount());
}

function refreshTabLockQueueDepth() {
  let queued = 0;
  for (const lock of tabLocks.values()) {
    if (lock?.queue) queued += lock.queue.length;
  }
  tabLockQueueDepth.set(queued);
}

async function withPageLoadDuration(action, fn) {
  const end = pageLoadDuration.startTimer();
  try {
    return await fn();
  } finally {
    end();
  }
}



async function waitForPageReady(page, options = {}) {
  const {
    timeout = 10000,
    waitForNetwork = true,
    waitForHydration = true,
    settleMs = 200,
    hydrationPollMs = 250,
    hydrationTimeoutMs = Math.min(timeout, 10000),
  } = options;
  
  try {
    await page.waitForLoadState('domcontentloaded', { timeout });
    
    if (waitForNetwork) {
      await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {
        log('warn', 'networkidle timeout, continuing');
      });
    }
    
    if (waitForHydration) {
      const maxIterations = Math.max(1, Math.floor(hydrationTimeoutMs / hydrationPollMs));
      await page.evaluate(async ({ maxIterations, hydrationPollMs }) => {
        for (let i = 0; i < maxIterations; i++) {
          const entries = performance.getEntriesByType('resource');
          const recentEntries = entries.slice(-5);
          const netQuiet = recentEntries.every(e => (performance.now() - e.responseEnd) > 400);
          
          if (document.readyState === 'complete' && netQuiet) {
            await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
            break;
          }
          await new Promise(r => setTimeout(r, hydrationPollMs));
        }
      }, { maxIterations, hydrationPollMs }).catch(() => {
        log('warn', 'hydration wait failed, continuing');
      });
    }
    
    if (settleMs > 0) {
      await page.waitForTimeout(settleMs);
    }
    
    // Auto-dismiss common consent/privacy dialogs
    await dismissConsentDialogs(page);
    
    return true;
  } catch (err) {
    log('warn', 'page ready failed', { error: err.message });
    return false;
  }
}

async function dismissConsentDialogs(page) {
  // Common consent/privacy dialog selectors (matches Swift WebView.swift patterns)
  const dismissSelectors = [
    // OneTrust (very common)
    '#onetrust-banner-sdk button#onetrust-accept-btn-handler',
    '#onetrust-banner-sdk button#onetrust-reject-all-handler',
    '#onetrust-close-btn-container button',
    // Generic patterns
    'button[data-test="cookie-accept-all"]',
    'button[aria-label="Accept all"]',
    'button[aria-label="Accept All"]',
    'button[aria-label="Close"]',
    'button[aria-label="Dismiss"]',
    // Dialog close buttons
    'dialog button:has-text("Close")',
    'dialog button:has-text("Accept")',
    'dialog button:has-text("I Accept")',
    'dialog button:has-text("Got it")',
    'dialog button:has-text("OK")',
    // GDPR/CCPA specific
    '[class*="consent"] button[class*="accept"]',
    '[class*="consent"] button[class*="close"]',
    '[class*="privacy"] button[class*="close"]',
    '[class*="cookie"] button[class*="accept"]',
    '[class*="cookie"] button[class*="close"]',
    // Overlay close buttons
    '[class*="modal"] button[class*="close"]',
    '[class*="overlay"] button[class*="close"]',
  ];
  
  for (const selector of dismissSelectors) {
    try {
      const button = page.locator(selector).first();
      if (await button.isVisible({ timeout: 100 })) {
        await button.click({ timeout: 1000 }).catch(() => {});
        log('info', 'dismissed consent dialog', { selector });
        await page.waitForTimeout(300); // Brief pause after dismiss
        break; // Only dismiss one dialog per page load
      }
    } catch (e) {
      // Selector not found or not clickable, continue
    }
  }
}

// --- Google SERP detection ---
function isGoogleSerp(url) {
  try {
    const parsed = new URL(url);
    return parsed.hostname.includes('google.') && parsed.pathname === '/search';
  } catch {
    return false;
  }
}

function isGoogleSearchUrl(url) {
  try {
    const parsed = new URL(url);
    return parsed.hostname.includes('google.') && parsed.pathname === '/search';
  } catch {
    return false;
  }
}

async function isGoogleSearchBlocked(page) {
  if (!page || page.isClosed()) return false;

  const url = page.url();
  if (url.includes('google.com/sorry/')) return true;

  const bodyText = await page.evaluate(() => document.body?.innerText?.slice(0, 600) || '').catch(() => '');
  return /Our systems have detected unusual traffic|About this page|If you're having trouble accessing Google Search|SG_REL/.test(bodyText);
}

// --- Google SERP: combined extraction (refs + snapshot in one DOM pass) ---
// Returns { refs: Map, snapshot: string }
async function extractGoogleSerp(page) {
  const refs = new Map();
  if (!page || page.isClosed()) return { refs, snapshot: '' };
  
  const start = Date.now();
  
  const alreadyRendered = await page.evaluate(() => !!document.querySelector('#rso h3, #search h3, #rso [data-snhf]')).catch(() => false);
  if (!alreadyRendered) {
    try {
      await page.waitForSelector('#rso h3, #search h3, #rso [data-snhf]', { timeout: 5000 });
    } catch {
      try {
        await page.waitForSelector('#rso a[href]:not([href^="/search"]), #search a[href]:not([href^="/search"])', { timeout: 2000 });
      } catch {}
    }
  }
  
  const extracted = await page.evaluate(() => {
    const snapshot = [];
    const elements = [];
    let refCounter = 1;
    
    function addRef(role, name) {
      const id = 'e' + refCounter++;
      elements.push({ id, role, name });
      return id;
    }
    
    snapshot.push('- heading "' + document.title.replace(/"/g, '\\"') + '"');
    
    const searchInput = document.querySelector('input[name="q"], textarea[name="q"]');
    if (searchInput) {
      const name = 'Search';
      const refId = addRef('searchbox', name);
      snapshot.push('- searchbox "' + name + '" [' + refId + ']: ' + (searchInput.value || ''));
    }
    
    const navContainer = document.querySelector('div[role="navigation"], div[role="list"]');
    if (navContainer) {
      const navLinks = navContainer.querySelectorAll('a');
      if (navLinks.length > 0) {
        snapshot.push('- navigation:');
        navLinks.forEach(a => {
          const text = (a.textContent || '').trim();
          if (!text || text.length < 1) return;
          if (/^\d+$/.test(text) && parseInt(text) < 50) return;
          const refId = addRef('link', text);
          snapshot.push('  - link "' + text + '" [' + refId + ']');
        });
      }
    }
    
    const resultContainer = document.querySelector('#rso') || document.querySelector('#search');
    if (resultContainer) {
      const resultBlocks = resultContainer.querySelectorAll(':scope > div');
      for (const block of resultBlocks) {
        const h3 = block.querySelector('h3');
        const mainLink = h3 ? h3.closest('a') : null;
        
        if (h3 && mainLink) {
          const title = h3.textContent.trim().replace(/"/g, '\\"');
          const href = mainLink.href;
          const cite = block.querySelector('cite');
          const displayUrl = cite ? cite.textContent.trim() : '';
          
          let snippet = '';
          for (const sel of ['[data-sncf]', '[data-content-feature="1"]', '.VwiC3b', 'div[style*="-webkit-line-clamp"]', 'span.aCOpRe']) {
            const el = block.querySelector(sel);
            if (el) { snippet = el.textContent.trim().slice(0, 300); break; }
          }
          if (!snippet) {
            const allText = block.textContent.trim().replace(/\s+/g, ' ');
            const titleLen = title.length + (displayUrl ? displayUrl.length : 0);
            if (allText.length > titleLen + 20) {
              snippet = allText.slice(titleLen).trim().slice(0, 300);
            }
          }
          
          const refId = addRef('link', title);
          snapshot.push('- link "' + title + '" [' + refId + ']:');
          snapshot.push('  - /url: ' + href);
          if (displayUrl) snapshot.push('  - cite: ' + displayUrl);
          if (snippet) snapshot.push('  - text: ' + snippet);
        } else {
          const blockLinks = block.querySelectorAll('a[href^="http"]:not([href*="google.com/search"])');
          if (blockLinks.length > 0) {
            const blockText = block.textContent.trim().replace(/\s+/g, ' ').slice(0, 200);
            if (blockText.length > 10) {
              snapshot.push('- group:');
              snapshot.push('  - text: ' + blockText);
              blockLinks.forEach(a => {
                const linkText = (a.textContent || '').trim().replace(/"/g, '\\"').slice(0, 100);
                if (linkText.length > 2) {
                  const refId = addRef('link', linkText);
                  snapshot.push('  - link "' + linkText + '" [' + refId + ']:');
                  snapshot.push('    - /url: ' + a.href);
                }
              });
            }
          }
        }
      }
    }
    
    const paaItems = document.querySelectorAll('[jsname="Cpkphb"], div.related-question-pair');
    if (paaItems.length > 0) {
      snapshot.push('- heading "People also ask"');
      paaItems.forEach(q => {
        const text = (q.textContent || '').trim().replace(/"/g, '\\"').slice(0, 150);
        if (text) {
          const refId = addRef('button', text);
          snapshot.push('  - button "' + text + '" [' + refId + ']');
        }
      });
    }
    
    const nextLink = document.querySelector('#botstuff a[aria-label="Next page"], td.d6cvqb a, a#pnnext');
    if (nextLink) {
      const refId = addRef('link', 'Next');
      snapshot.push('- navigation "pagination":');
      snapshot.push('  - link "Next" [' + refId + ']');
    }
    
    return { snapshot: snapshot.join('\n'), elements };
  });
  
  const seenCounts = new Map();
  for (const el of extracted.elements) {
    const key = `${el.role}:${el.name}`;
    const nth = seenCounts.get(key) || 0;
    seenCounts.set(key, nth + 1);
    refs.set(el.id, { role: el.role, name: el.name, nth });
  }
  
  log('info', 'extractGoogleSerp', { elapsed: Date.now() - start, refs: refs.size });
  return { refs, snapshot: extracted.snapshot };
}

const REFRESH_READY_TIMEOUT_MS = 2500;

async function buildRefs(page) {
  const refs = new Map();
  
  if (!page || page.isClosed()) {
    log('warn', 'buildRefs: page closed or invalid');
    return refs;
  }
  
  // Google SERP fast path -- skip ariaSnapshot entirely
  const url = page.url();
  if (isGoogleSerp(url)) {
    const { refs: googleRefs } = await extractGoogleSerp(page);
    return googleRefs;
  }
  
  const start = Date.now();
  
  // Hard total timeout on the entire buildRefs operation
  let timerId;
  const timeoutPromise = new Promise((_, reject) => {
    timerId = setTimeout(() => reject(new Error('buildRefs_timeout')), BUILDREFS_TIMEOUT_MS);
  });
  
  try {
    const result = await Promise.race([
      _buildRefsInner(page, refs, start),
      timeoutPromise
    ]);
    clearTimeout(timerId);
    return result;
  } catch (err) {
    clearTimeout(timerId);
    if (err.message === 'buildRefs_timeout') {
      log('warn', 'buildRefs: total timeout exceeded', { elapsed: Date.now() - start });
      return refs;
    }
    throw err;
  }
}

async function _buildRefsInner(page, refs, start) {
  await waitForPageReady(page, {
    timeout: REFRESH_READY_TIMEOUT_MS,
    waitForNetwork: false,
    waitForHydration: false,
    settleMs: 100,
  });
  
  // Budget remaining time for ariaSnapshot
  const elapsed = Date.now() - start;
  const remaining = BUILDREFS_TIMEOUT_MS - elapsed;
  if (remaining < 2000) {
    log('warn', 'buildRefs: insufficient time for ariaSnapshot', { elapsed });
    return refs;
  }
  
  let ariaYaml;
  try {
    ariaYaml = await page.locator('body').ariaSnapshot({ timeout: Math.min(remaining - 1000, 5000) });
  } catch (err) {
    log('warn', 'ariaSnapshot failed, retrying');
    const retryBudget = BUILDREFS_TIMEOUT_MS - (Date.now() - start);
    if (retryBudget < 2000) return refs;
    try {
      ariaYaml = await page.locator('body').ariaSnapshot({ timeout: Math.min(retryBudget - 500, 5000) });
    } catch (retryErr) {
      log('warn', 'ariaSnapshot retry failed, returning empty refs', { error: retryErr.message });
      return refs;
    }
  }
  
  if (!ariaYaml) {
    log('warn', 'buildRefs: no aria snapshot');
    return refs;
  }
  
  const lines = ariaYaml.split('\n');
  let refCounter = 1;
  
  // Track occurrences of each role+name combo for nth disambiguation
  const seenCounts = new Map(); // "role:name" -> count
  
  for (const line of lines) {
    if (refCounter > MAX_SNAPSHOT_NODES) break;
    
    const match = line.match(/^\s*-\s+(\w+)(?:\s+"([^"]*)")?/);
    if (match) {
      const [, role, name] = match;
      const normalizedRole = role.toLowerCase();
      
      if (normalizedRole === 'combobox') continue;
      
      if (name && SKIP_PATTERNS.some(p => p.test(name))) continue;
      
      if (INTERACTIVE_ROLES.includes(normalizedRole)) {
        const normalizedName = name || '';
        const key = `${normalizedRole}:${normalizedName}`;
        
        // Get current count and increment
        const nth = seenCounts.get(key) || 0;
        seenCounts.set(key, nth + 1);
        
        const refId = `e${refCounter++}`;
        refs.set(refId, { role: normalizedRole, name: normalizedName, nth });
      }
    }
  }
  
  return refs;
}

async function getAriaSnapshot(page) {
  if (!page || page.isClosed()) {
    return null;
  }
  await waitForPageReady(page, {
    timeout: REFRESH_READY_TIMEOUT_MS,
    waitForNetwork: false,
    waitForHydration: false,
    settleMs: 100,
  });
  try {
    return await page.locator('body').ariaSnapshot({ timeout: 5000 });
  } catch (err) {
    log('warn', 'getAriaSnapshot failed', { error: err.message });
    return null;
  }
}

function refToLocator(page, ref, refs) {
  const info = refs.get(ref);
  if (!info) return null;
  
  const { role, name, nth } = info;
  let locator = page.getByRole(role, name ? { name } : undefined);
  
  // Always use .nth() to disambiguate duplicate role+name combinations
  // This avoids "strict mode violation" when multiple elements match
  locator = locator.nth(nth);
  
  return locator;
}

async function refreshTabRefs(tabState, options = {}) {
  const {
    reason = 'refresh',
    timeoutMs = null,
    preserveExistingOnEmpty = true,
  } = options;

  const beforeUrl = tabState.page?.url?.() || '';
  const existingRefs = tabState.refs instanceof Map ? tabState.refs : new Map();
  const refreshPromise = buildRefs(tabState.page);

  let refreshedRefs;
  if (timeoutMs) {
    const timeoutLabel = `${reason}_refs_timeout`;
    refreshedRefs = await Promise.race([
      refreshPromise,
      new Promise((_, reject) => setTimeout(() => reject(new Error(timeoutLabel)), timeoutMs)),
    ]);
  } else {
    refreshedRefs = await refreshPromise;
  }

  const afterUrl = tabState.page?.url?.() || beforeUrl;
  if (preserveExistingOnEmpty && refreshedRefs.size === 0 && existingRefs.size > 0 && beforeUrl === afterUrl) {
    log('warn', 'preserving previous refs after empty rebuild', {
      reason,
      url: afterUrl,
      previousRefs: existingRefs.size,
    });
    return existingRefs;
  }

  return refreshedRefs;
}


/**
 * @openapi
 * /health:
 *   get:
 *     tags: [System]
 *     summary: Health check
 *     description: Detailed health with tab/session counts and failure tracking.
 *     responses:
 *       200:
 *         description: Healthy.
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 ok:
 *                   type: boolean
 *                 engine:
 *                   type: string
 *                 browserConnected:
 *                   type: boolean
 *                 browserRunning:
 *                   type: boolean
 *                 activeTabs:
 *                   type: integer
 *                 activeSessions:
 *                   type: integer
 *                 consecutiveFailures:
 *                   type: integer
 *       503:
 *         description: Unhealthy or recovering.
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 ok:
 *                   type: boolean
 *                 recovering:
 *                   type: boolean
 */
app.get('/health', (req, res) => {
  if (healthState.isRecovering) {
    return res.status(503).json({ ok: false, engine: 'camoufox', recovering: true });
  }
  const running = browser !== null && (browser.isConnected?.() ?? false);
  if (proxyPool?.canRotateSessions && !running) {
    scheduleBrowserWarmRetry();
    return res.status(503).json({
      ok: false,
      engine: 'camoufox',
      browserConnected: false,
      browserRunning: false,
      warming: true,
      ...(FLY_MACHINE_ID ? { machineId: FLY_MACHINE_ID } : {}),
    });
  }
  const mem = process.memoryUsage();
  const rssMb = Math.round(mem.rss / 1048576);
  const heapUsedMb = Math.round(mem.heapUsed / 1048576);
  const nativeMemMb = rssMb - heapUsedMb;
  res.json({ 
    ok: true, 
    engine: 'camoufox',
    browserConnected: running,
    browserRunning: running,
    activeTabs: getTotalTabCount(),
    activeSessions: sessions.size,
    consecutiveFailures: healthState.consecutiveNavFailures,
    memory: { rssMb, heapUsedMb, nativeMemMb },
    ...(FLY_MACHINE_ID ? { machineId: FLY_MACHINE_ID } : {}),
  });
});

/**
 * @openapi
 * /metrics:
 *   get:
 *     tags: [System]
 *     summary: Prometheus metrics
 *     description: Returns Prometheus text exposition format. Requires PROMETHEUS_ENABLED=1.
 *     responses:
 *       200:
 *         description: Prometheus metrics.
 *         content:
 *           text/plain:
 *             schema:
 *               type: string
 *       404:
 *         description: Metrics disabled.
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 */
app.get('/metrics', async (_req, res) => {
  const reg = getRegister();
  if (!reg) {
    res.status(404).json({ error: 'Prometheus metrics disabled. Set PROMETHEUS_ENABLED=1 to enable.' });
    return;
  }
  res.set('Content-Type', reg.contentType);
  res.send(await reg.metrics());
});

// Create new tab
/**
 * @openapi
 * /tabs:
 *   post:
 *     tags: [Tabs]
 *     summary: Create a new tab
 *     description: Creates a tab in the given session. Optionally navigates to an initial URL.
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [userId, sessionKey]
 *             properties:
 *               userId:
 *                 type: string
 *                 description: Session owner.
 *               sessionKey:
 *                 type: string
 *                 description: Tab group identifier.
 *               listItemId:
 *                 type: string
 *                 description: Legacy alias for sessionKey.
 *               url:
 *                 type: string
 *                 description: Optional initial URL.
 *               trace:
 *                 type: boolean
 *                 description: Enable Playwright tracing for this session (screenshots, DOM snapshots, network). Must be set on first tab creation; cannot be added to an existing session.
 *     responses:
 *       200:
 *         description: Tab created.
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 tabId:
 *                   type: string
 *                 url:
 *                   type: string
 *       400:
 *         description: Missing required fields.
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *       429:
 *         description: Tab limit reached.
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *       409:
 *         description: Cannot enable tracing on an existing session.
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 */
app.post('/tabs', async (req, res) => {
  try {
    const { userId, sessionKey, listItemId, url, trace } = req.body;
    // Accept both sessionKey (preferred) and listItemId (legacy) for backward compatibility
    const resolvedSessionKey = sessionKey || listItemId;
    if (!userId || !resolvedSessionKey) {
      return res.status(400).json({ error: 'userId and sessionKey required' });
    }

    const result = await withTimeout((async () => {
      const existing = sessions.get(normalizeUserId(userId));
      if (trace && existing && !existing.tracePath) {
        throw Object.assign(
          new Error('trace must be set on session creation. DELETE /sessions/:userId first to restart with tracing.'),
          { statusCode: 409 },
        );
      }
      const session = await getSession(userId, { trace: !!trace });
      
      let totalTabs = 0;
      for (const group of session.tabGroups.values()) totalTabs += group.size;
      
      // Recycle oldest tab when limits are reached instead of rejecting
      if (totalTabs >= MAX_TABS_PER_SESSION || getTotalTabCount() >= MAX_TABS_GLOBAL) {
        const recycled = await recycleOldestTab(session, req.reqId, userId);
        if (!recycled) {
          throw Object.assign(new Error('Maximum tabs per session reached'), { statusCode: 429 });
        }
      }
      
      const group = getTabGroup(session, resolvedSessionKey);
      
      const page = await session.context.newPage();
      const tabId = fly.makeTabId();
      const tabState = createTabState(page);
      attachDownloadListener(tabState, tabId, log, pluginEvents, userId);
      group.set(tabId, tabState);
      refreshActiveTabsGauge();
      
      if (url) {
        const urlErr = validateUrl(url);
        if (urlErr) throw Object.assign(new Error(urlErr), { statusCode: 400 });
        tabState.lastRequestedUrl = url;
        await withPageLoadDuration('open_url', () => page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 }));
        tabState.visitedUrls.add(url);
      }
      
      pluginEvents.emit('tab:created', { userId, tabId, page, url: page.url() });
      log('info', 'tab created', { reqId: req.reqId, tabId, userId, sessionKey: resolvedSessionKey, url: page.url() });
      return { tabId, url: page.url() };
    })(), requestTimeoutMs(), 'tab create');

    res.json(result);
  } catch (err) {
    log('error', 'tab create failed', { reqId: req.reqId, error: err.message });
    handleRouteError(err, req, res);
  }
});

// Navigate
/**
 * @openapi
 * /tabs/{tabId}/navigate:
 *   post:
 *     tags: [Navigation]
 *     summary: Navigate a tab to a URL or macro
 *     description: Navigate to a URL or expand a search macro. Auto-creates tab if not found.
 *     parameters:
 *       - name: tabId
 *         in: path
 *         required: true
 *         schema:
 *           type: string
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [userId]
 *             properties:
 *               userId:
 *                 type: string
 *               url:
 *                 type: string
 *               macro:
 *                 type: string
 *                 description: Search macro (e.g. @google_search).
 *               query:
 *                 type: string
 *                 description: Search query for macro.
 *               sessionKey:
 *                 type: string
 *               listItemId:
 *                 type: string
 *     responses:
 *       200:
 *         description: Navigation result with snapshot.
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *       400:
 *         description: Bad request.
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *       404:
 *         description: Tab not found.
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 */
app.post('/tabs/:tabId/navigate', async (req, res) => {
  const tabId = req.params.tabId;
  
  try {
    const { userId, url, macro, query, sessionKey, listItemId } = req.body;
    if (!userId) return res.status(400).json({ error: 'userId required' });

    const result = await withUserLimit(userId, () => withTimeout((async () => {
      await ensureBrowser();
      const resolvedSessionKey = sessionKey || listItemId || 'default';
      let session = sessions.get(normalizeUserId(userId));
      let found = session && findTab(session, tabId);
      
      let tabState;
      if (!found) {
        session = await getSession(userId);
        let sessionTabs = 0;
        for (const g of session.tabGroups.values()) sessionTabs += g.size;
        if (getTotalTabCount() >= MAX_TABS_GLOBAL || sessionTabs >= MAX_TABS_PER_SESSION) {
          // Recycle oldest tab to free a slot, then create new page
          const recycled = await recycleOldestTab(session, req.reqId, userId);
          if (!recycled) {
            throw new Error('Maximum tabs per session reached');
          }
        }
        {
          const page = await session.context.newPage();
          tabState = createTabState(page);
          attachDownloadListener(tabState, tabId, log, pluginEvents, userId);
          const group = getTabGroup(session, resolvedSessionKey);
          group.set(tabId, tabState);
          refreshActiveTabsGauge();
          log('info', 'tab auto-created on navigate', { reqId: req.reqId, tabId, userId });
        }
      } else {
        tabState = found.tabState;
      }
      tabState.toolCalls++; tabState.consecutiveTimeouts = 0; tabState.consecutiveFailures = 0;
      
      let targetUrl = url;
      if (macro && macro !== '__NO__' && macro !== 'none' && macro !== 'null') {
        targetUrl = expandMacro(macro, query) || url;
      }
      
      if (!targetUrl) throw new Error('url or macro required');
      
      const urlErr = validateUrl(targetUrl);
      if (urlErr) throw new Error(urlErr);
      
      return await withTabLock(tabId, async () => {
        const currentSessionKey = found?.listItemId || resolvedSessionKey;
        const isGoogleSearch = isGoogleSearchUrl(targetUrl);

        const navigateCurrentPage = async () => {
          tabState.lastRequestedUrl = targetUrl;
          const ac = tabState.navigateAbort = new AbortController();
          const gotoP = withPageLoadDuration('navigate', () => tabState.page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 30000 }));
          try {
            await Promise.race([
              gotoP,
              new Promise((_, reject) => ac.signal.addEventListener('abort', () => reject(new Error('Navigation aborted: tab deleted')), { once: true })),
            ]);
            tabState.visitedUrls.add(targetUrl);
            tabState.lastSnapshot = null;
          } catch (err) {
            gotoP.catch(() => {}); // suppress unhandled rejection from still-pending goto
            throw err;
          } finally {
            tabState.navigateAbort = null;
          }
        };

        const prewarmGoogleHome = async () => {
          if (!isGoogleSearch || tabState.visitedUrls.has('https://www.google.com/')) return;
          await withPageLoadDuration('navigate', () => tabState.page.goto('https://www.google.com/', { waitUntil: 'domcontentloaded', timeout: 30000 }));
          tabState.visitedUrls.add('https://www.google.com/');
          await tabState.page.waitForTimeout(1200);
        };

        const recreateTabOnFreshContext = async () => {
          const previousRetryCount = tabState.googleRetryCount || 0;
          browserRestartsTotal.labels('google_search_block').inc();
          // Rotate at context level -- destroy this user's session and create
          // a fresh one with a new proxy session. Does NOT restart the browser.
          const key = normalizeUserId(userId);
          const oldSession = sessions.get(key);
          if (oldSession) {
            await closeSession(key, oldSession, { reason: 'google_blocked_context_rotate', clearDownloads: true, clearLocks: true });
          }
          session = await getSession(userId);
          const group = getTabGroup(session, currentSessionKey);
          const page = await session.context.newPage();
          tabState = createTabState(page);
          tabState.googleRetryCount = previousRetryCount + 1;
          attachDownloadListener(tabState, tabId, log, pluginEvents, userId);
          group.set(tabId, tabState);
          refreshActiveTabsGauge();
        };

        if (isGoogleSearch && proxyPool?.canRotateSessions) {
          await prewarmGoogleHome();
        }

        await navigateCurrentPage();

        if (isGoogleSearch && proxyPool?.canRotateSessions && await isGoogleSearchBlocked(tabState.page)) {
          log('warn', 'google search blocked, rotating browser proxy session', {
            reqId: req.reqId,
            tabId,
            url: tabState.page.url(),
            proxySession: browserLaunchProxy?.sessionId || null,
          });
          await recreateTabOnFreshContext();
          await prewarmGoogleHome();
          await navigateCurrentPage();
        }
        
        // For Google SERP: skip eager ref building during navigate.
        // Results render asynchronously after DOMContentLoaded -- the snapshot
        // call will wait for and extract them.
        if (isGoogleSerp(tabState.page.url())) {
          tabState.refs = new Map();
          return { ok: true, tabId, url: tabState.page.url(), refsAvailable: false, googleSerp: true };
        }

        if (isGoogleSearch && await isGoogleSearchBlocked(tabState.page)) {
          return { ok: false, tabId, url: tabState.page.url(), refsAvailable: false, googleBlocked: true };
        }
        
        tabState.refs = await buildRefs(tabState.page);
        return { ok: true, tabId, url: tabState.page.url(), refsAvailable: tabState.refs.size > 0 };
      }, requestTimeoutMs());
    })(), requestTimeoutMs(), 'navigate'));
    
    log('info', 'navigated', { reqId: req.reqId, tabId, url: result.url });
    pluginEvents.emit('tab:navigated', { userId: req.body.userId, tabId, url: result.url, prevUrl: null });
    res.json(result);
  } catch (err) {
    log('error', 'navigate failed', { reqId: req.reqId, tabId, error: err.message });
    const is400 = err.message && (err.message.startsWith('Blocked URL scheme') || err.message === 'url or macro required');
    if (is400) {
      return res.status(400).json({ error: safeError(err) });
    }
    handleRouteError(err, req, res);
  }
});

// Snapshot
/**
 * @openapi
 * /tabs/{tabId}/snapshot:
 *   get:
 *     tags: [Content]
 *     summary: Accessibility snapshot
 *     description: Returns accessibility tree with element refs. Supports pagination via offset.
 *     parameters:
 *       - name: tabId
 *         in: path
 *         required: true
 *         schema:
 *           type: string
 *       - name: userId
 *         in: query
 *         required: true
 *         schema:
 *           type: string
 *       - name: format
 *         in: query
 *         schema:
 *           type: string
 *           enum: [text, json]
 *           default: text
 *       - name: offset
 *         in: query
 *         schema:
 *           type: integer
 *         description: Character offset for paginated retrieval.
 *       - name: includeScreenshot
 *         in: query
 *         schema:
 *           type: string
 *           enum: ['true', 'false']
 *     responses:
 *       200:
 *         description: Snapshot.
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 url:
 *                   type: string
 *                 snapshot:
 *                   type: string
 *                 refsCount:
 *                   type: integer
 *                 truncated:
 *                   type: boolean
 *                 totalChars:
 *                   type: integer
 *                 hasMore:
 *                   type: boolean
 *                 nextOffset:
 *                   type: integer
 *       404:
 *         description: Tab not found.
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 */
app.get('/tabs/:tabId/snapshot', async (req, res) => {
  try {
    const userId = req.query.userId;
    if (!userId) return res.status(400).json({ error: 'userId required' });
    const format = req.query.format || 'text';
    const offset = parseInt(req.query.offset) || 0;
    const session = sessions.get(normalizeUserId(userId));
    const found = session && findTab(session, req.params.tabId);
    if (!found) return res.status(404).json({ error: 'Tab not found' });
    
    const { tabState } = found;
    tabState.toolCalls++; tabState.consecutiveTimeouts = 0; tabState.consecutiveFailures = 0;

    // Cached chunk retrieval for offset>0 requests
    if (offset > 0 && tabState.lastSnapshot) {
      const win = windowSnapshot(tabState.lastSnapshot, offset);
      const response = { url: tabState.page.url(), snapshot: win.text, refsCount: tabState.refs.size, truncated: win.truncated, totalChars: win.totalChars, hasMore: win.hasMore, nextOffset: win.nextOffset };
      if (req.query.includeScreenshot === 'true') {
        const pngBuffer = await tabState.page.screenshot({ type: 'png' });
        response.screenshot = { data: pngBuffer.toString('base64'), mimeType: 'image/png' };
      }
      log('info', 'snapshot (cached offset)', { reqId: req.reqId, tabId: req.params.tabId, offset, totalChars: win.totalChars });
      return res.json(response);
    }

    const result = await withUserLimit(userId, () => withTimeout((async () => {
      if (proxyPool?.canRotateSessions && isGoogleSearchUrl(tabState.lastRequestedUrl || '')) {
        const blocked = await isGoogleSearchBlocked(tabState.page);
        const unavailable = !blocked && await isGoogleUnavailable(tabState.page);
        if (blocked || unavailable) {
          const rotated = await rotateGoogleTab(userId, found.listItemId, req.params.tabId, tabState, blocked ? 'google_search_block_snapshot' : 'google_search_unavailable_snapshot', req.reqId);
          if (rotated) {
            tabState.page = rotated.tabState.page;
            tabState.refs = rotated.tabState.refs;
            tabState.visitedUrls = rotated.tabState.visitedUrls;
            tabState.downloads = rotated.tabState.downloads;
            tabState.toolCalls = rotated.tabState.toolCalls;
            tabState.consecutiveTimeouts = rotated.tabState.consecutiveTimeouts;
            tabState.lastSnapshot = rotated.tabState.lastSnapshot;
            tabState.lastRequestedUrl = rotated.tabState.lastRequestedUrl;
            tabState.googleRetryCount = rotated.tabState.googleRetryCount;
          }
        }
      }

      const pageUrl = tabState.page.url();
      
      // Google SERP fast path -- DOM extraction instead of ariaSnapshot
      if (isGoogleSerp(pageUrl)) {
        const { refs: googleRefs, snapshot: googleSnapshot } = await extractGoogleSerp(tabState.page);
        tabState.refs = googleRefs;
        tabState.lastSnapshot = googleSnapshot;
        snapshotBytes.labels('google_serp').observe(Buffer.byteLength(googleSnapshot, 'utf8'));
        const annotatedYaml = googleSnapshot;
        const win = windowSnapshot(annotatedYaml, 0);
        const response = {
          url: pageUrl,
          snapshot: win.text,
          refsCount: tabState.refs.size,
          truncated: win.truncated,
          totalChars: win.totalChars,
          hasMore: win.hasMore,
          nextOffset: win.nextOffset,
        };
        if (req.query.includeScreenshot === 'true') {
          const pngBuffer = await tabState.page.screenshot({ type: 'png' });
          response.screenshot = { data: pngBuffer.toString('base64'), mimeType: 'image/png' };
        }
        return response;
      }
      
      tabState.refs = await refreshTabRefs(tabState, { reason: 'snapshot' });
      const ariaYaml = await getAriaSnapshot(tabState.page);
      
      let annotatedYaml = ariaYaml || '';
      if (annotatedYaml && tabState.refs.size > 0) {
        const refsByKey = new Map();
        for (const [refId, info] of tabState.refs) {
          const key = `${info.role}:${info.name}:${info.nth}`;
          refsByKey.set(key, refId);
        }
        
        const annotationCounts = new Map();
        const lines = annotatedYaml.split('\n');
        
        annotatedYaml = lines.map(line => {
          const match = line.match(/^(\s*-\s+)(\w+)(\s+"([^"]*)")?(.*)$/);
          if (match) {
            const [, prefix, role, nameMatch, name, suffix] = match;
            const normalizedRole = role.toLowerCase();
            if (normalizedRole === 'combobox') return line;
            if (name && SKIP_PATTERNS.some(p => p.test(name))) return line;
            if (INTERACTIVE_ROLES.includes(normalizedRole)) {
              const normalizedName = name || '';
              const countKey = `${normalizedRole}:${normalizedName}`;
              const nth = annotationCounts.get(countKey) || 0;
              annotationCounts.set(countKey, nth + 1);
              const key = `${normalizedRole}:${normalizedName}:${nth}`;
              const refId = refsByKey.get(key);
              if (refId) {
                return `${prefix}${role}${nameMatch || ''} [${refId}]${suffix}`;
              }
            }
          }
          return line;
        }).join('\n');
      }
      
      tabState.lastSnapshot = annotatedYaml;
      if (annotatedYaml) snapshotBytes.labels('full').observe(Buffer.byteLength(annotatedYaml, 'utf8'));
      const win = windowSnapshot(annotatedYaml, 0);

      const response = {
        url: tabState.page.url(),
        snapshot: win.text,
        refsCount: tabState.refs.size,
        truncated: win.truncated,
        totalChars: win.totalChars,
        hasMore: win.hasMore,
        nextOffset: win.nextOffset,
      };

      if (req.query.includeScreenshot === 'true') {
        const pngBuffer = await tabState.page.screenshot({ type: 'png' });
        response.screenshot = { data: pngBuffer.toString('base64'), mimeType: 'image/png' };
      }

      return response;
    })(), requestTimeoutMs(), 'snapshot'));

    pluginEvents.emit('tab:snapshot', { userId: req.query.userId, tabId: req.params.tabId, snapshot: result.snapshot });
    log('info', 'snapshot', { reqId: req.reqId, tabId: req.params.tabId, url: result.url, snapshotLen: result.snapshot?.length, refsCount: result.refsCount, hasScreenshot: !!result.screenshot, truncated: result.truncated });
    res.json(result);
  } catch (err) {
    log('error', 'snapshot failed', { reqId: req.reqId, tabId: req.params.tabId, error: err.message });
    handleRouteError(err, req, res);
  }
});

// Wait for page ready
/**
 * @openapi
 * /tabs/{tabId}/wait:
 *   post:
 *     tags: [Interaction]
 *     summary: Wait for a selector or timeout
 *     parameters:
 *       - name: tabId
 *         in: path
 *         required: true
 *         schema:
 *           type: string
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [userId]
 *             properties:
 *               userId:
 *                 type: string
 *               selector:
 *                 type: string
 *               timeout:
 *                 type: integer
 *                 description: Max wait in ms.
 *     responses:
 *       200:
 *         description: Wait completed.
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 ok:
 *                   type: boolean
 *       404:
 *         description: Tab not found.
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 */
app.post('/tabs/:tabId/wait', async (req, res) => {
  try {
    const { userId, timeout = 10000, waitForNetwork = true } = req.body;
    const session = sessions.get(normalizeUserId(userId));
    const found = session && findTab(session, req.params.tabId);
    if (!found) return res.status(404).json({ error: 'Tab not found' });
    
    const { tabState } = found;
    const ready = await waitForPageReady(tabState.page, { timeout, waitForNetwork });
    
    res.json({ ok: true, ready });
  } catch (err) {
    log('error', 'wait failed', { reqId: req.reqId, error: err.message });
    handleRouteError(err, req, res);
  }
});

// Click
/**
 * @openapi
 * /tabs/{tabId}/click:
 *   post:
 *     tags: [Interaction]
 *     summary: Click an element
 *     description: Click by element ref, CSS selector, or coordinates.
 *     parameters:
 *       - name: tabId
 *         in: path
 *         required: true
 *         schema:
 *           type: string
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [userId]
 *             properties:
 *               userId:
 *                 type: string
 *               ref:
 *                 type: string
 *                 description: Element ref ID (e.g. "e3").
 *               selector:
 *                 type: string
 *                 description: CSS selector fallback.
 *               doubleClick:
 *                 type: boolean
 *               coordinates:
 *                 type: object
 *                 properties:
 *                   x:
 *                     type: number
 *                   y:
 *                     type: number
 *     responses:
 *       200:
 *         description: Click result with optional post-action snapshot.
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *       400:
 *         description: Bad request.
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *       404:
 *         description: Tab not found.
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 */
app.post('/tabs/:tabId/click', async (req, res) => {
  const tabId = req.params.tabId;
  
  try {
    const { userId, ref, selector } = req.body;
    if (!userId) return res.status(400).json({ error: 'userId required' });
    const session = sessions.get(normalizeUserId(userId));
    const found = session && findTab(session, tabId);
    if (!found) return res.status(404).json({ error: 'Tab not found' });
    
    const { tabState } = found;
    tabState.toolCalls++; tabState.consecutiveTimeouts = 0; tabState.consecutiveFailures = 0;
    
    if (!ref && !selector) {
      return res.status(400).json({ error: 'ref or selector required' });
    }
    
    const result = await withUserLimit(userId, () => withTabLock(tabId, async () => {
      const clickStart = Date.now();
      const remainingBudget = () => Math.max(0, HANDLER_TIMEOUT_MS - 2000 - (Date.now() - clickStart));
      // Full mouse event sequence for stubborn JS click handlers (mirrors Swift WebView.swift)
      // Dispatches: mouseover -> mouseenter -> mousedown -> mouseup -> click
      const dispatchMouseSequence = async (locator) => {
        const box = await locator.boundingBox();
        if (!box) throw new Error('Element not visible (no bounding box)');
        
        const x = box.x + box.width / 2;
        const y = box.y + box.height / 2;
        
        // Move mouse to element (triggers mouseover/mouseenter)
        await tabState.page.mouse.move(x, y);
        await tabState.page.waitForTimeout(50);
        
        // Full click sequence
        await tabState.page.mouse.down();
        await tabState.page.waitForTimeout(50);
        await tabState.page.mouse.up();
        
        log('info', 'mouse sequence dispatched', { x: x.toFixed(0), y: y.toFixed(0) });
      };
      
      // On Google SERPs, skip the normal click attempt (always intercepted by overlays)
      // and go directly to force click -- saves 5s timeout per click
      const onGoogleSerp = isGoogleSerp(tabState.page.url());
      
      const doClick = async (locatorOrSelector, isLocator) => {
        const locator = isLocator ? locatorOrSelector : tabState.page.locator(locatorOrSelector);
        
        if (onGoogleSerp) {
          try {
            await locator.click({ timeout: 3000, force: true });
          } catch (forceErr) {
            log('warn', 'google force click failed, trying mouse sequence');
            await dispatchMouseSequence(locator);
          }
          return;
        }
        
        try {
          // First try normal click (respects visibility, enabled, not-obscured)
          await locator.click({ timeout: 3000 });
        } catch (err) {
          // Fallback 1: If intercepted by overlay, retry with force
          if (err.message.includes('intercepts pointer events')) {
            log('warn', 'click intercepted, retrying with force');
            try {
              await locator.click({ timeout: 3000, force: true });
            } catch (forceErr) {
              // Fallback 2: Full mouse event sequence for stubborn JS handlers
              log('warn', 'force click failed, trying mouse sequence');
              await dispatchMouseSequence(locator);
            }
          } else if (err.message.includes('not visible') || err.message.toLowerCase().includes('timeout')) {
            // Fallback 2: Element not responding to click, try mouse sequence
            log('warn', 'click timeout, trying mouse sequence');
            await dispatchMouseSequence(locator);
          } else {
            throw err;
          }
        }
      };
      
      if (ref) {
        let locator = refToLocator(tabState.page, ref, tabState.refs);
        if (!locator) {
          // Use tight timeout (4s max) to leave budget for click + post-click buildRefs
          log('info', 'auto-refreshing refs before click', { ref, hadRefs: tabState.refs.size });
          try {
            const preClickBudget = Math.min(4000, remainingBudget());
            tabState.refs = await refreshTabRefs(tabState, { reason: 'pre_click', timeoutMs: preClickBudget });
          } catch (e) {
            if (e.message === 'pre_click_refs_timeout' || e.message === 'buildRefs_timeout') {
              log('warn', 'pre-click buildRefs timed out, proceeding without refresh');
            } else {
              throw e;
            }
          }
          locator = refToLocator(tabState.page, ref, tabState.refs);
        }
        if (!locator) {
          const maxRef = tabState.refs.size > 0 ? `e${tabState.refs.size}` : 'none';
          throw new StaleRefsError(ref, maxRef, tabState.refs.size);
        }
        await doClick(locator, true);
      } else {
        await doClick(selector, false);
      }
      
      // If clicking on a Google SERP, wait for potential navigation to complete
      if (onGoogleSerp) {
        try {
          await tabState.page.waitForLoadState('domcontentloaded', { timeout: 3000 });
        } catch {}
        await tabState.page.waitForTimeout(200);
        // Skip buildRefs here -- SERP clicks typically navigate to a new page,
        // and the caller always requests /snapshot next which rebuilds refs.
        tabState.lastSnapshot = null;
        tabState.refs = new Map();
        const newUrl = tabState.page.url();
        tabState.visitedUrls.add(newUrl);
        return { ok: true, url: newUrl, refsAvailable: false };
      } else {
        await tabState.page.waitForTimeout(500);
      }
      tabState.lastSnapshot = null;
      // buildRefs after click -- use remaining budget (min 2s) so we don't blow the handler timeout.
      // If it times out, return without refs (caller's next /snapshot will rebuild them).
      const postClickBudget = Math.max(2000, remainingBudget());
      try {
        tabState.refs = await refreshTabRefs(tabState, { reason: 'post_click', timeoutMs: postClickBudget });
      } catch (e) {
        if (e.message === 'post_click_refs_timeout' || e.message === 'buildRefs_timeout') {
          log('warn', 'post-click buildRefs timed out, returning without refs', { budget: postClickBudget, elapsed: Date.now() - clickStart });
          tabState.refs = new Map();
        } else {
          throw e;
        }
      }
      
      const newUrl = tabState.page.url();
      tabState.visitedUrls.add(newUrl);
      return { ok: true, url: newUrl, refsAvailable: tabState.refs.size > 0 };
    }));
    
    log('info', 'clicked', { reqId: req.reqId, tabId, url: result.url });
    pluginEvents.emit('tab:click', { userId: req.body.userId, tabId, ref: req.body.ref, selector: req.body.selector });
    res.json(result);
  } catch (err) {
    log('error', 'click failed', { reqId: req.reqId, tabId, error: err.message });
    if (err.message?.includes('timed out')) {
      try {
        const session = sessions.get(normalizeUserId(req.body.userId));
        const found = session && findTab(session, tabId);
        if (found?.tabState?.page && !found.tabState.page.isClosed()) {
          found.tabState.refs = await refreshTabRefs(found.tabState, { reason: 'click_timeout' });
          found.tabState.lastSnapshot = null;
          return res.status(500).json({
            error: safeError(err),
            hint: 'The page may have changed. Call snapshot to see the current state and retry.',
            url: found.tabState.page.url(),
            refsCount: found.tabState.refs.size,
          });
        }
      } catch (refreshErr) {
        log('warn', 'post-timeout refresh failed', { error: refreshErr.message });
      }
    }
    handleRouteError(err, req, res);
  }
});

// Type
/**
 * @openapi
 * /tabs/{tabId}/type:
 *   post:
 *     tags: [Interaction]
 *     summary: Type text into an element
 *     description: Types text into a focused element or a specific ref/selector.
 *     parameters:
 *       - name: tabId
 *         in: path
 *         required: true
 *         schema:
 *           type: string
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [userId, text]
 *             properties:
 *               userId:
 *                 type: string
 *               ref:
 *                 type: string
 *               selector:
 *                 type: string
 *               text:
 *                 type: string
 *               clear:
 *                 type: boolean
 *                 description: Clear field before typing.
 *               submit:
 *                 type: boolean
 *                 description: Press Enter after typing.
 *     responses:
 *       200:
 *         description: Type result.
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *       400:
 *         description: Bad request.
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *       404:
 *         description: Tab not found.
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 */
app.post('/tabs/:tabId/type', async (req, res) => {
  const tabId = req.params.tabId;
  
  try {
    const { userId, ref, selector, text, mode = 'fill', delay = 30, submit = false, pressEnter = false } = req.body;
    const session = sessions.get(normalizeUserId(userId));
    const found = session && findTab(session, tabId);
    if (!found) return res.status(404).json({ error: 'Tab not found' });
    
    const { tabState } = found;
    tabState.toolCalls++; tabState.consecutiveTimeouts = 0; tabState.consecutiveFailures = 0;
    
    if (mode !== 'fill' && mode !== 'keyboard') {
      return res.status(400).json({ error: "mode must be 'fill' or 'keyboard'" });
    }
    if (typeof text !== 'string') {
      return res.status(400).json({ error: 'text is required' });
    }
    // keyboard mode: ref/selector are optional (types into current focus)
    if (mode === 'fill' && !ref && !selector) {
      return res.status(400).json({ error: 'ref or selector required for mode=fill' });
    }
    const shouldSubmit = submit || pressEnter;
    
    await withTabLock(tabId, async () => {
      // Resolve and focus the target if ref/selector provided
      let locator = null;
      if (ref) {
        locator = refToLocator(tabState.page, ref, tabState.refs);
        if (!locator) {
          log('info', 'auto-refreshing refs before type', { ref, hadRefs: tabState.refs.size, mode });
          tabState.refs = await refreshTabRefs(tabState, { reason: 'type' });
          locator = refToLocator(tabState.page, ref, tabState.refs);
        }
        if (!locator) { const maxRef = tabState.refs.size > 0 ? `e${tabState.refs.size}` : 'none'; throw new StaleRefsError(ref, maxRef, tabState.refs.size); }
      }
      
      if (mode === 'fill') {
        if (locator) {
          await locator.fill(text, { timeout: 10000 });
        } else {
          await tabState.page.fill(selector, text, { timeout: 10000 });
        }
      } else {
        // keyboard mode -- char-by-char real key events (required for Ember/contenteditable)
        if (locator) {
          await locator.focus({ timeout: 10000 });
        } else if (selector) {
          await tabState.page.focus(selector, { timeout: 10000 });
        }
        await tabState.page.keyboard.type(text, { delay });
      }
      if (shouldSubmit) await tabState.page.keyboard.press('Enter');
    });
    
    pluginEvents.emit('tab:type', { userId: req.body.userId, tabId, text: req.body.text, ref: req.body.ref, mode: req.body.mode || 'fill' });
    res.json({ ok: true });
  } catch (err) {
    log('error', 'type failed', { reqId: req.reqId, error: err.message });
    if (err.message?.includes('timed out') || err.message?.includes('not an <input>')) {
      try {
        const session = sessions.get(normalizeUserId(req.body.userId));
        const found = session && findTab(session, tabId);
        if (found?.tabState?.page && !found.tabState.page.isClosed()) {
          found.tabState.refs = await refreshTabRefs(found.tabState, { reason: 'type_timeout' });
          found.tabState.lastSnapshot = null;
          return res.status(500).json({
            error: safeError(err),
            hint: 'The page may have changed. Call snapshot to see the current state and retry.',
            url: found.tabState.page.url(),
            refsCount: found.tabState.refs.size,
          });
        }
      } catch (refreshErr) {
        log('warn', 'post-timeout refresh failed', { error: refreshErr.message });
      }
    }
    handleRouteError(err, req, res);
  }
});

// Press key
/**
 * @openapi
 * /tabs/{tabId}/press:
 *   post:
 *     tags: [Interaction]
 *     summary: Press a keyboard key
 *     parameters:
 *       - name: tabId
 *         in: path
 *         required: true
 *         schema:
 *           type: string
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [userId, key]
 *             properties:
 *               userId:
 *                 type: string
 *               key:
 *                 type: string
 *                 description: Key name (e.g. "Enter", "Escape", "Tab").
 *     responses:
 *       200:
 *         description: Key pressed.
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 ok:
 *                   type: boolean
 *       404:
 *         description: Tab not found.
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 */
app.post('/tabs/:tabId/press', async (req, res) => {
  const tabId = req.params.tabId;
  
  try {
    const { userId, key } = req.body;
    const session = sessions.get(normalizeUserId(userId));
    const found = session && findTab(session, tabId);
    if (!found) return res.status(404).json({ error: 'Tab not found' });
    
    const { tabState } = found;
    tabState.toolCalls++; tabState.consecutiveTimeouts = 0; tabState.consecutiveFailures = 0;
    
    await withTabLock(tabId, async () => {
      await tabState.page.keyboard.press(key);
    });
    
    pluginEvents.emit('tab:press', { userId, tabId, key });
    res.json({ ok: true });
  } catch (err) {
    log('error', 'press failed', { reqId: req.reqId, error: err.message });
    handleRouteError(err, req, res);
  }
});

// Scroll
/**
 * @openapi
 * /tabs/{tabId}/scroll:
 *   post:
 *     tags: [Interaction]
 *     summary: Scroll the page
 *     parameters:
 *       - name: tabId
 *         in: path
 *         required: true
 *         schema:
 *           type: string
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [userId]
 *             properties:
 *               userId:
 *                 type: string
 *               direction:
 *                 type: string
 *                 description: '"up" or "down" (default "down").'
 *               amount:
 *                 type: integer
 *                 description: Pixels to scroll.
 *     responses:
 *       200:
 *         description: Scroll result.
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 ok:
 *                   type: boolean
 *       404:
 *         description: Tab not found.
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 */
app.post('/tabs/:tabId/scroll', async (req, res) => {
  try {
    const { userId, direction = 'down', amount = 500 } = req.body;
    const session = sessions.get(normalizeUserId(userId));
    const found = session && findTab(session, req.params.tabId);
    if (!found) return res.status(404).json({ error: 'Tab not found' });
    
    const { tabState } = found;
    tabState.toolCalls++; tabState.consecutiveTimeouts = 0; tabState.consecutiveFailures = 0;
    
    const isVertical = direction === 'up' || direction === 'down';
    const delta = (direction === 'up' || direction === 'left') ? -amount : amount;
    await tabState.page.mouse.wheel(isVertical ? 0 : delta, isVertical ? delta : 0);
    await tabState.page.waitForTimeout(300);
    
    pluginEvents.emit('tab:scroll', { userId, tabId: req.params.tabId, direction, amount });
    res.json({ ok: true });
  } catch (err) {
    log('error', 'scroll failed', { reqId: req.reqId, error: err.message });
    handleRouteError(err, req, res);
  }
});

// Back
/**
 * @openapi
 * /tabs/{tabId}/back:
 *   post:
 *     tags: [Navigation]
 *     summary: Go back
 *     parameters:
 *       - name: tabId
 *         in: path
 *         required: true
 *         schema:
 *           type: string
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [userId]
 *             properties:
 *               userId:
 *                 type: string
 *     responses:
 *       200:
 *         description: Navigated back.
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 ok:
 *                   type: boolean
 *                 url:
 *                   type: string
 *       404:
 *         description: Tab not found.
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 */
app.post('/tabs/:tabId/back', async (req, res) => {
  const tabId = req.params.tabId;
  
  try {
    const { userId } = req.body;
    const session = sessions.get(normalizeUserId(userId));
    const found = session && findTab(session, tabId);
    if (!found) return res.status(404).json({ error: 'Tab not found' });
    
    const { tabState } = found;
    tabState.toolCalls++; tabState.consecutiveTimeouts = 0; tabState.consecutiveFailures = 0;
    
    const result = await withTabLock(tabId, async () => {
      try {
        await tabState.page.goBack({ timeout: 10000 });
      } catch (navErr) {
        // NS_BINDING_CANCELLED_OLD_LOAD: Firefox cancels the old load when going back.
        // The navigation itself succeeded -- just the prior page's load was interrupted.
        if (navErr.message && navErr.message.includes('NS_BINDING_CANCELLED')) {
          log('info', 'goBack cancelled old load (expected)', { reqId: req.reqId, tabId });
        } else {
          throw navErr;
        }
      }
      tabState.refs = await buildRefs(tabState.page);
      return { ok: true, url: tabState.page.url() };
    });
    
    res.json(result);
  } catch (err) {
    log('error', 'back failed', { reqId: req.reqId, error: err.message });
    handleRouteError(err, req, res);
  }
});

// Forward
/**
 * @openapi
 * /tabs/{tabId}/forward:
 *   post:
 *     tags: [Navigation]
 *     summary: Go forward
 *     parameters:
 *       - name: tabId
 *         in: path
 *         required: true
 *         schema:
 *           type: string
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [userId]
 *             properties:
 *               userId:
 *                 type: string
 *     responses:
 *       200:
 *         description: Navigated forward.
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 ok:
 *                   type: boolean
 *                 url:
 *                   type: string
 *       404:
 *         description: Tab not found.
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 */
app.post('/tabs/:tabId/forward', async (req, res) => {
  const tabId = req.params.tabId;
  
  try {
    const { userId } = req.body;
    const session = sessions.get(normalizeUserId(userId));
    const found = session && findTab(session, tabId);
    if (!found) return res.status(404).json({ error: 'Tab not found' });
    
    const { tabState } = found;
    tabState.toolCalls++; tabState.consecutiveTimeouts = 0; tabState.consecutiveFailures = 0;
    
    const result = await withTabLock(tabId, async () => {
      await tabState.page.goForward({ timeout: 10000 });
      tabState.refs = await buildRefs(tabState.page);
      return { ok: true, url: tabState.page.url() };
    });
    
    res.json(result);
  } catch (err) {
    log('error', 'forward failed', { reqId: req.reqId, error: err.message });
    handleRouteError(err, req, res);
  }
});

// Refresh
/**
 * @openapi
 * /tabs/{tabId}/refresh:
 *   post:
 *     tags: [Navigation]
 *     summary: Refresh page
 *     parameters:
 *       - name: tabId
 *         in: path
 *         required: true
 *         schema:
 *           type: string
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [userId]
 *             properties:
 *               userId:
 *                 type: string
 *     responses:
 *       200:
 *         description: Page refreshed.
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 ok:
 *                   type: boolean
 *                 url:
 *                   type: string
 *       404:
 *         description: Tab not found.
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 */
app.post('/tabs/:tabId/refresh', async (req, res) => {
  const tabId = req.params.tabId;
  
  try {
    const { userId } = req.body;
    const session = sessions.get(normalizeUserId(userId));
    const found = session && findTab(session, tabId);
    if (!found) return res.status(404).json({ error: 'Tab not found' });
    
    const { tabState } = found;
    tabState.toolCalls++; tabState.consecutiveTimeouts = 0; tabState.consecutiveFailures = 0;
    
    const result = await withTabLock(tabId, async () => {
      await tabState.page.reload({ timeout: 30000 });
      tabState.refs = await buildRefs(tabState.page);
      return { ok: true, url: tabState.page.url() };
    });
    
    res.json(result);
  } catch (err) {
    log('error', 'refresh failed', { reqId: req.reqId, error: err.message });
    handleRouteError(err, req, res);
  }
});

// Get links
/**
 * @openapi
 * /tabs/{tabId}/links:
 *   get:
 *     tags: [Content]
 *     summary: Extract page links
 *     parameters:
 *       - name: tabId
 *         in: path
 *         required: true
 *         schema:
 *           type: string
 *       - name: userId
 *         in: query
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Links extracted.
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 links:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       text:
 *                         type: string
 *                       href:
 *                         type: string
 *                       ref:
 *                         type: string
 *       404:
 *         description: Tab not found.
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 */
app.get('/tabs/:tabId/links', async (req, res) => {
  try {
    const userId = req.query.userId;
    const limit = parseInt(req.query.limit) || 50;
    const offset = parseInt(req.query.offset) || 0;
    const session = sessions.get(normalizeUserId(userId));
    const found = session && findTab(session, req.params.tabId);
    if (!found) {
      log('warn', 'links: tab not found', { reqId: req.reqId, tabId: req.params.tabId, userId, hasSession: !!session });
      return res.status(404).json({ error: 'Tab not found' });
    }
    
    const { tabState } = found;
    tabState.toolCalls++; tabState.consecutiveTimeouts = 0; tabState.consecutiveFailures = 0;
    
    const allLinks = await tabState.page.evaluate(() => {
      const links = [];
      document.querySelectorAll('a[href]').forEach(a => {
        const href = a.href;
        const text = a.textContent?.trim().slice(0, 100) || '';
        if (href && href.startsWith('http')) {
          links.push({ url: href, text });
        }
      });
      return links;
    });
    
    const total = allLinks.length;
    const paginated = allLinks.slice(offset, offset + limit);
    
    res.json({
      links: paginated,
      pagination: { total, offset, limit, hasMore: offset + limit < total }
    });
  } catch (err) {
    log('error', 'links failed', { reqId: req.reqId, error: err.message });
    handleRouteError(err, req, res);
  }
});

// Get captured downloads
/**
 * @openapi
 * /tabs/{tabId}/downloads:
 *   get:
 *     tags: [Content]
 *     summary: List tab downloads
 *     parameters:
 *       - name: tabId
 *         in: path
 *         required: true
 *         schema:
 *           type: string
 *       - name: userId
 *         in: query
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Downloads list.
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 downloads:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       filename:
 *                         type: string
 *                       url:
 *                         type: string
 *                       state:
 *                         type: string
 *       404:
 *         description: Tab not found.
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 */
app.get('/tabs/:tabId/downloads', async (req, res) => {
  try {
    const userId = req.query.userId;
    const includeData = req.query.includeData === 'true';
    const consume = req.query.consume === 'true';
    const maxBytesRaw = Number(req.query.maxBytes);
    const maxBytes = Number.isFinite(maxBytesRaw) && maxBytesRaw > 0 ? maxBytesRaw : MAX_DOWNLOAD_INLINE_BYTES;
    const session = sessions.get(normalizeUserId(userId));
    const found = session && findTab(session, req.params.tabId);
    if (!found) return res.status(404).json({ error: 'Tab not found' });

    const { tabState } = found;
    tabState.toolCalls++;

    const downloads = await getDownloadsList(tabState, { includeData, maxBytes });

    if (consume) {
      await clearTabDownloads(tabState);
    }

    res.json({ tabId: req.params.tabId, downloads });
  } catch (err) {
    failuresTotal.labels(classifyError(err), 'downloads').inc();
    log('error', 'downloads failed', { reqId: req.reqId, error: err.message });
    res.status(500).json({ error: safeError(err) });
  }
});

// Get image elements from current page
/**
 * @openapi
 * /tabs/{tabId}/images:
 *   get:
 *     tags: [Content]
 *     summary: Extract page images
 *     parameters:
 *       - name: tabId
 *         in: path
 *         required: true
 *         schema:
 *           type: string
 *       - name: userId
 *         in: query
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Images extracted.
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 images:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       src:
 *                         type: string
 *                       alt:
 *                         type: string
 *                       width:
 *                         type: integer
 *                       height:
 *                         type: integer
 *       404:
 *         description: Tab not found.
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 */
app.get('/tabs/:tabId/images', async (req, res) => {
  try {
    const userId = req.query.userId;
    const includeData = req.query.includeData === 'true';
    const maxBytesRaw = Number(req.query.maxBytes);
    const limitRaw = Number(req.query.limit);
    const maxBytes = Number.isFinite(maxBytesRaw) && maxBytesRaw > 0 ? maxBytesRaw : MAX_DOWNLOAD_INLINE_BYTES;
    const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(Math.floor(limitRaw), 20) : 8;
    const session = sessions.get(normalizeUserId(userId));
    const found = session && findTab(session, req.params.tabId);
    if (!found) return res.status(404).json({ error: 'Tab not found' });

    const { tabState } = found;
    tabState.toolCalls++;

    const images = await extractPageImages(tabState.page, { includeData, maxBytes, limit });

    res.json({ tabId: req.params.tabId, images });
  } catch (err) {
    failuresTotal.labels(classifyError(err), 'images').inc();
    log('error', 'images failed', { reqId: req.reqId, error: err.message });
    res.status(500).json({ error: safeError(err) });
  }
});

// Screenshot
/**
 * @openapi
 * /tabs/{tabId}/screenshot:
 *   get:
 *     tags: [Content]
 *     summary: Take a screenshot
 *     description: Returns a base64-encoded PNG screenshot.
 *     parameters:
 *       - name: tabId
 *         in: path
 *         required: true
 *         schema:
 *           type: string
 *       - name: userId
 *         in: query
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Screenshot.
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 screenshot:
 *                   type: object
 *                   properties:
 *                     data:
 *                       type: string
 *                     mimeType:
 *                       type: string
 *       404:
 *         description: Tab not found.
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 */
app.get('/tabs/:tabId/screenshot', async (req, res) => {
  try {
    const userId = req.query.userId;
    const fullPage = req.query.fullPage === 'true';
    const session = sessions.get(normalizeUserId(userId));
    const found = session && findTab(session, req.params.tabId);
    if (!found) return res.status(404).json({ error: 'Tab not found' });
    
    const { tabState } = found;
    const buffer = await tabState.page.screenshot({ type: 'png', fullPage });
    pluginEvents.emit('tab:screenshot', { userId, tabId: req.params.tabId, buffer });
    res.set('Content-Type', 'image/png');
    res.send(buffer);
  } catch (err) {
    log('error', 'screenshot failed', { reqId: req.reqId, error: err.message });
    handleRouteError(err, req, res);
  }
});

// Stats
/**
 * @openapi
 * /tabs/{tabId}/stats:
 *   get:
 *     tags: [Tabs]
 *     summary: Tab statistics
 *     description: Returns tab metadata including URL, tool call count, visited URLs, download/failure counts.
 *     parameters:
 *       - name: tabId
 *         in: path
 *         required: true
 *         schema:
 *           type: string
 *       - name: userId
 *         in: query
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Tab stats.
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 tabId:
 *                   type: string
 *                 url:
 *                   type: string
 *                 toolCalls:
 *                   type: integer
 *                 visitedUrls:
 *                   type: array
 *                   items:
 *                     type: string
 *                 downloadCount:
 *                   type: integer
 *                 consecutiveFailures:
 *                   type: integer
 *       404:
 *         description: Tab not found.
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 */
app.get('/tabs/:tabId/stats', async (req, res) => {
  try {
    const userId = req.query.userId;
    const session = sessions.get(normalizeUserId(userId));
    const found = session && findTab(session, req.params.tabId);
    if (!found) return res.status(404).json({ error: 'Tab not found' });
    
    const { tabState, listItemId } = found;
    res.json({
      tabId: req.params.tabId,
      sessionKey: listItemId,
      listItemId, // Legacy compatibility
      url: tabState.page.url(),
      visitedUrls: Array.from(tabState.visitedUrls),
      downloadsCount: Array.isArray(tabState.downloads) ? tabState.downloads.length : 0,
      toolCalls: tabState.toolCalls,
      refsCount: tabState.refs.size
    });
  } catch (err) {
    log('error', 'stats failed', { reqId: req.reqId, error: err.message });
    handleRouteError(err, req, res);
  }
});

// Evaluate JavaScript in page context
/**
 * @openapi
 * /tabs/{tabId}/evaluate:
 *   post:
 *     tags: [Interaction]
 *     summary: Evaluate JavaScript in tab
 *     description: Runs arbitrary JS in the page context and returns the result.
 *     parameters:
 *       - name: tabId
 *         in: path
 *         required: true
 *         schema:
 *           type: string
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [userId, expression]
 *             properties:
 *               userId:
 *                 type: string
 *               expression:
 *                 type: string
 *                 description: JavaScript expression to evaluate.
 *     responses:
 *       200:
 *         description: Evaluation result.
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 ok:
 *                   type: boolean
 *                 result: {}
 *       400:
 *         description: Bad request.
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *       404:
 *         description: Tab not found.
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 */
app.post('/tabs/:tabId/evaluate', express.json({ limit: '1mb' }), async (req, res) => {
  try {
    const { userId, expression } = req.body;
    if (!userId) return res.status(400).json({ error: 'userId is required' });
    if (!expression) return res.status(400).json({ error: 'expression is required' });

    const session = sessions.get(normalizeUserId(userId));
    const found = session && findTab(session, req.params.tabId);
    if (!found) return res.status(404).json({ error: 'Tab not found' });

    session.lastAccess = Date.now();
    const { tabState } = found;
    tabState.toolCalls++; tabState.consecutiveTimeouts = 0; tabState.consecutiveFailures = 0;

    pluginEvents.emit('tab:evaluate', { userId, tabId: req.params.tabId, expression });
    const result = await tabState.page.evaluate(expression);
    pluginEvents.emit('tab:evaluated', { userId, tabId: req.params.tabId, result });
    log('info', 'evaluate', { reqId: req.reqId, tabId: req.params.tabId, userId, resultType: typeof result });
    res.json({ ok: true, result });
  } catch (err) {
    failuresTotal.labels(classifyError(err), 'evaluate').inc();
    log('error', 'evaluate failed', { reqId: req.reqId, error: err.message });
    res.status(500).json({ error: safeError(err) });
  }
});

// Structured extraction using JSON Schema with x-ref hints
/**
 * @openapi
 * /tabs/{tabId}/extract:
 *   post:
 *     tags: [Content]
 *     summary: Structured data extraction via JSON Schema
 *     description: |
 *       Extracts structured data from the current page using a JSON Schema whose properties
 *       carry `x-ref` hints pointing at snapshot element refs (e.g. `e1`, `e2`).  
 *       Call `GET /tabs/{tabId}/snapshot` first to populate the ref table.
 *     parameters:
 *       - name: tabId
 *         in: path
 *         required: true
 *         schema:
 *           type: string
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [userId, schema]
 *             properties:
 *               userId:
 *                 type: string
 *               schema:
 *                 type: object
 *                 description: |
 *                   JSON Schema with `type: "object"` and a `properties` map.  
 *                   Each property may include `x-ref` (a snapshot element ref) and an optional
 *                   `type` (`string`, `number`, `integer`, `boolean`).
 *                 required: [type, properties]
 *                 properties:
 *                   type:
 *                     type: string
 *                     enum: [object]
 *                   properties:
 *                     type: object
 *                     additionalProperties:
 *                       type: object
 *                       properties:
 *                         type:
 *                           type: string
 *                           enum: [string, number, integer, boolean, object, "null"]
 *                         x-ref:
 *                           type: string
 *                           description: Snapshot element ref (e.g. `e1`).
 *                   required:
 *                     type: array
 *                     items:
 *                       type: string
 *                     description: Property names that must resolve to a non-null value.
 *     responses:
 *       200:
 *         description: Extraction succeeded.
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 ok:
 *                   type: boolean
 *                 data:
 *                   type: object
 *                   description: Extracted key-value pairs matching the input schema.
 *       400:
 *         description: Missing userId, missing schema, or invalid schema.
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *       404:
 *         description: Tab not found.
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *       409:
 *         description: No refs available -- call snapshot first.
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 error:
 *                   type: string
 *                 snapshot:
 *                   type: string
 *                   nullable: true
 *       422:
 *         description: Extraction failed (e.g. required ref not found).
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 ok:
 *                   type: boolean
 *                 error:
 *                   type: string
 *                 snapshot:
 *                   type: string
 *                   nullable: true
 *       500:
 *         description: Internal server error.
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 */
app.post('/tabs/:tabId/extract', express.json({ limit: '256kb' }), async (req, res) => {
  try {
    const { userId, schema } = req.body;
    if (!userId) return res.status(400).json({ error: 'userId is required' });
    if (!schema) return res.status(400).json({ error: 'schema is required' });

    const check = validateExtractSchema(schema);
    if (!check.ok) return res.status(400).json({ error: check.error });

    const session = sessions.get(normalizeUserId(userId));
    const found = session && findTab(session, req.params.tabId);
    if (!found) return res.status(404).json({ error: 'Tab not found' });

    session.lastAccess = Date.now();
    const { tabState } = found;
    tabState.toolCalls++; tabState.consecutiveTimeouts = 0;

    if (!tabState.refs || tabState.refs.size === 0) {
      return res.status(409).json({
        error: 'no refs available -- call GET /tabs/:tabId/snapshot first to build the ref table',
        snapshot: tabState.lastSnapshot || null,
      });
    }

    try {
      const data = extractDeterministic({ schema, refs: tabState.refs });
      log('info', 'extract', { reqId: req.reqId, tabId: req.params.tabId, userId, keys: Object.keys(data) });
      res.json({ ok: true, data });
    } catch (extractErr) {
      log('warn', 'extract failed', { reqId: req.reqId, error: extractErr.message });
      res.status(422).json({ ok: false, error: extractErr.message, snapshot: tabState.lastSnapshot || null });
    }
  } catch (err) {
    failuresTotal.labels(classifyError(err), 'extract').inc();
    log('error', 'extract error', { reqId: req.reqId, error: err.message });
    res.status(500).json({ error: safeError(err) });
  }
});

// Close tab
/**
 * @openapi
 * /tabs/{tabId}:
 *   delete:
 *     tags: [Tabs]
 *     summary: Close a tab
 *     parameters:
 *       - name: tabId
 *         in: path
 *         required: true
 *         schema:
 *           type: string
 *       - name: userId
 *         in: query
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Tab closed.
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 ok:
 *                   type: boolean
 *       404:
 *         description: Tab not found.
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 */
app.delete('/tabs/:tabId', async (req, res) => {
  try {
    const userId = req.query.userId || req.body?.userId;
    if (!userId) return res.status(400).json({ error: 'userId required (query or body)' });
    const session = sessions.get(normalizeUserId(userId));
    const found = session && findTab(session, req.params.tabId);
    if (found) {
      if (found.tabState.navigateAbort) found.tabState.navigateAbort.abort();
      await clearTabDownloads(found.tabState);
      await safePageClose(found.tabState.page);
      found.group.delete(req.params.tabId);
      { const _l = tabLocks.get(req.params.tabId); if (_l) _l.drain(); tabLocks.delete(req.params.tabId); refreshTabLockQueueDepth(); }
      if (found.group.size === 0) {
        session.tabGroups.delete(found.listItemId);
      }
      refreshActiveTabsGauge();
      log('info', 'tab closed', { reqId: req.reqId, tabId: req.params.tabId, userId });
    }
    res.json({ ok: true });
  } catch (err) {
    log('error', 'tab close failed', { reqId: req.reqId, error: err.message });
    handleRouteError(err, req, res);
  }
});

// Close tab group
/**
 * @openapi
 * /tabs/group/{listItemId}:
 *   delete:
 *     tags: [Tabs]
 *     summary: Close all tabs in a group
 *     parameters:
 *       - name: listItemId
 *         in: path
 *         required: true
 *         schema:
 *           type: string
 *       - name: userId
 *         in: query
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Group closed.
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 ok:
 *                   type: boolean
 *                 closed:
 *                   type: integer
 *       404:
 *         description: Session not found.
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 */
app.delete('/tabs/group/:listItemId', async (req, res) => {
  try {
    const userId = req.query.userId || req.body?.userId;
    if (!userId) return res.status(400).json({ error: 'userId required (query or body)' });
    const session = sessions.get(normalizeUserId(userId));
    const group = session?.tabGroups.get(req.params.listItemId);
    if (group) {
      for (const [tabId, tabState] of group) {
        await clearTabDownloads(tabState);
        await safePageClose(tabState.page);
        const lock = tabLocks.get(tabId);
        if (lock) {
          lock.drain();
          tabLocks.delete(tabId);
        }
      }
      session.tabGroups.delete(req.params.listItemId);
      refreshTabLockQueueDepth();
      refreshActiveTabsGauge();
      log('info', 'tab group closed', { reqId: req.reqId, listItemId: req.params.listItemId, userId });
    }
    res.json({ ok: true });
  } catch (err) {
    log('error', 'tab group close failed', { reqId: req.reqId, error: err.message });
    handleRouteError(err, req, res);
  }
});

// List trace files for a session
/**
 * @openapi
 * /sessions/{userId}/traces:
 *   get:
 *     tags: [Sessions]
 *     summary: List trace files
 *     description: Returns all Playwright trace zip files for the given user session, sorted newest first.
 *     security:
 *       - BearerAuth: []
 *     parameters:
 *       - name: userId
 *         in: path
 *         required: true
 *         schema:
 *           type: string
 *         description: Session owner identifier.
 *     responses:
 *       200:
 *         description: Trace list.
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 traces:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       filename:
 *                         type: string
 *                       sizeBytes:
 *                         type: integer
 *                       createdAt:
 *                         type: number
 *                       modifiedAt:
 *                         type: number
 *       403:
 *         description: Forbidden.
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *       500:
 *         description: Server error.
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 */
app.get('/sessions/:userId/traces', authMiddleware(), async (req, res) => {
  try {
    const userId = normalizeUserId(req.params.userId);
    const traces = await listUserTraces(CONFIG.tracesDir, userId);
    res.json({ traces });
  } catch (err) {
    log('error', 'list traces failed', { error: err.message });
    res.status(500).json({ error: err.message });
  }
});

// Stream one trace file
/**
 * @openapi
 * /sessions/{userId}/traces/{filename}:
 *   get:
 *     tags: [Sessions]
 *     summary: Download a trace file
 *     description: Streams a Playwright trace zip for viewing in trace.playwright.dev.
 *     security:
 *       - BearerAuth: []
 *     parameters:
 *       - name: userId
 *         in: path
 *         required: true
 *         schema:
 *           type: string
 *         description: Session owner identifier.
 *       - name: filename
 *         in: path
 *         required: true
 *         schema:
 *           type: string
 *         description: Trace zip filename.
 *     responses:
 *       200:
 *         description: Trace zip stream.
 *         content:
 *           application/zip:
 *             schema:
 *               type: string
 *               format: binary
 *       400:
 *         description: Invalid filename.
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *       404:
 *         description: Trace not found.
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *       403:
 *         description: Forbidden.
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *       500:
 *         description: Server error.
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 */
app.get('/sessions/:userId/traces/:filename', authMiddleware(), async (req, res) => {
  try {
    const userId = normalizeUserId(req.params.userId);
    const full = resolveTracePath(CONFIG.tracesDir, userId, req.params.filename);
    if (!full) return res.status(400).json({ error: 'invalid filename' });
    const st = await statTrace(full);
    if (!st) return res.status(404).json({ error: 'not found' });
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Length', String(st.size));
    const stream = fs.createReadStream(full);
    stream.on('error', (err) => {
      if (!res.headersSent) res.status(404).json({ error: 'not found' });
      else res.destroy();
    });
    stream.pipe(res);
  } catch (err) {
    log('error', 'stream trace failed', { error: err.message });
    res.status(500).json({ error: err.message });
  }
});

// Delete one trace file
/**
 * @openapi
 * /sessions/{userId}/traces/{filename}:
 *   delete:
 *     tags: [Sessions]
 *     summary: Delete a trace file
 *     description: Removes a specific Playwright trace zip from the server.
 *     security:
 *       - BearerAuth: []
 *     parameters:
 *       - name: userId
 *         in: path
 *         required: true
 *         schema:
 *           type: string
 *         description: Session owner identifier.
 *       - name: filename
 *         in: path
 *         required: true
 *         schema:
 *           type: string
 *         description: Trace zip filename.
 *     responses:
 *       200:
 *         description: Trace deleted.
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 ok:
 *                   type: boolean
 *       400:
 *         description: Invalid filename.
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *       404:
 *         description: Trace not found.
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *       403:
 *         description: Forbidden.
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *       500:
 *         description: Server error.
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 */
app.delete('/sessions/:userId/traces/:filename', authMiddleware(), async (req, res) => {
  try {
    const userId = normalizeUserId(req.params.userId);
    const full = resolveTracePath(CONFIG.tracesDir, userId, req.params.filename);
    if (!full) return res.status(400).json({ error: 'invalid filename' });
    try {
      await deleteTrace(full);
    } catch (err) {
      if (err.code === 'ENOENT') return res.status(404).json({ error: 'not found' });
      throw err;
    }
    res.json({ ok: true });
  } catch (err) {
    log('error', 'delete trace failed', { error: err.message });
    res.status(500).json({ error: err.message });
  }
});

// Close session
/**
 * @openapi
 * /sessions/{userId}:
 *   delete:
 *     tags: [Sessions]
 *     summary: Destroy a user session
 *     description: Closes all tabs and cleans up state for the given userId.
 *     parameters:
 *       - name: userId
 *         in: path
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Session destroyed.
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 ok:
 *                   type: boolean
 *                 closed:
 *                   type: integer
 *       404:
 *         description: Session not found.
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 */
app.delete('/sessions/:userId', async (req, res) => {
  try {
    const userId = normalizeUserId(req.params.userId);
    const session = sessions.get(userId);
    if (session) {
      await closeSession(userId, session, { reason: 'api_delete_session', clearDownloads: true, clearLocks: true });
      log('info', 'session closed', { userId });
    }
    if (sessions.size === 0) scheduleBrowserIdleShutdown();
    res.json({ ok: true });
  } catch (err) {
    log('error', 'session close failed', { error: err.message });
    handleRouteError(err, req, res);
  }
});

// Cleanup stale sessions
setInterval(() => {
  const now = Date.now();
  for (const [userId, session] of Array.from(sessions.entries())) {
    if (now - session.lastAccess > SESSION_TIMEOUT_MS) {
      session._closing = true;
      const idleMs = now - session.lastAccess;
      sessionsExpiredTotal.inc();
      pluginEvents.emit('session:expired', { userId, idleMs });
      closeSession(userId, session, { reason: 'session_timeout', clearDownloads: true, clearLocks: true }).catch(() => {});
      log('info', 'session expired', { userId });
    }
  }
  // When all sessions gone, start idle timer to kill browser
  if (sessions.size === 0) {
    scheduleBrowserIdleShutdown();
  }
  refreshTabLockQueueDepth();
}, 60_000);

// Per-tab inactivity reaper -- close tabs idle for TAB_INACTIVITY_MS
setInterval(() => {
  const now = Date.now();
  for (const [userId, session] of sessions) {
    for (const [listItemId, group] of session.tabGroups) {
      for (const [tabId, tabState] of group) {
        if (!tabState._lastReaperCheck) {
          tabState._lastReaperCheck = now;
          tabState._lastReaperToolCalls = tabState.toolCalls;
          continue;
        }
        if (tabState.toolCalls === tabState._lastReaperToolCalls) {
          const idleMs = now - tabState._lastReaperCheck;
          if (idleMs >= TAB_INACTIVITY_MS) {
            tabsReapedTotal.inc();
            log('info', 'tab reaped (inactive)', { userId, tabId, listItemId, idleMs, toolCalls: tabState.toolCalls });
            safePageClose(tabState.page);
            group.delete(tabId);
            { const _l = tabLocks.get(tabId); if (_l) _l.drain(); tabLocks.delete(tabId); }
            refreshTabLockQueueDepth();
            refreshActiveTabsGauge();
          }
        } else {
          tabState._lastReaperCheck = now;
          tabState._lastReaperToolCalls = tabState.toolCalls;
        }
      }
      if (group.size === 0) {
        session.tabGroups.delete(listItemId);
      }
    }
    // Clean up sessions with zero tabs remaining -- free browser context memory
    if (session.tabGroups.size === 0) {
      session._closing = true;
      log('info', 'session empty after tab reaper, closing', { userId });
      closeSession(userId, session, { reason: 'tab_reaper_empty_session', clearDownloads: true, clearLocks: true }).catch(() => {});
      sessionsExpiredTotal.inc();
    }
  }
  if (sessions.size === 0) scheduleBrowserIdleShutdown();
}, 60_000);

// Native memory pressure restart -- when all sessions are gone and Firefox's
// native memory has grown beyond threshold, kill the browser immediately instead
// of waiting for the idle timer. Firefox/Camoufox doesn't fully reclaim native
// memory after context.close() due to jemalloc fragmentation, JIT caches, and
// NSS/TLS session caches. See #1032.
setInterval(() => {
  if (sessions.size > 0 || !browser) return;
  const mem = process.memoryUsage();
  const nativeMemMb = Math.round((mem.rss - mem.heapUsed) / 1048576);
  if (_nativeMemBaseline === null) {
    _nativeMemBaseline = nativeMemMb;
    return;
  }
  const growth = nativeMemMb - _nativeMemBaseline;
  if (growth >= NATIVE_MEM_RESTART_THRESHOLD_MB) {
    log('warn', 'native memory pressure, restarting browser', {
      baselineMb: _nativeMemBaseline,
      currentMb: nativeMemMb,
      growthMb: growth,
      thresholdMb: NATIVE_MEM_RESTART_THRESHOLD_MB,
    });
    browserRestartsTotal.labels('memory_pressure').inc();
    closeBrowserFully('memory_pressure').catch((err) => {
      log('error', 'memory pressure browser close failed', { error: err.message });
    });
  }
}, 30_000);

// =============================================================================
// OpenClaw-compatible endpoint aliases
// These allow camoufox to be used as a profile backend for OpenClaw's browser tool
// =============================================================================

// GET / - Status (passive -- does not launch browser)
/**
 * @openapi
 * /:
 *   get:
 *     tags: [System]
 *     summary: Server status
 *     description: Returns basic server liveness and browser state.
 *     responses:
 *       200:
 *         description: Server status.
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 ok:
 *                   type: boolean
 *                 enabled:
 *                   type: boolean
 *                 running:
 *                   type: boolean
 *                 engine:
 *                   type: string
 *                 browserConnected:
 *                   type: boolean
 *                 browserRunning:
 *                   type: boolean
 */
app.get('/', (req, res) => {
  const running = browser !== null && (browser.isConnected?.() ?? false);
  res.json({ 
    ok: true,
    enabled: true,
    running,
    engine: 'camoufox',
    browserConnected: running,
    browserRunning: running,
  });
});

// GET /tabs - List all tabs (OpenClaw expects this)
/**
 * @openapi
 * /tabs:
 *   get:
 *     tags: [Tabs]
 *     summary: List open tabs
 *     description: Returns all tabs for a given userId.
 *     parameters:
 *       - name: userId
 *         in: query
 *         schema:
 *           type: string
 *         description: Filter by session owner.
 *     responses:
 *       200:
 *         description: Tab list.
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 running:
 *                   type: boolean
 *                 tabs:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       tabId:
 *                         type: string
 *                       targetId:
 *                         type: string
 *                       url:
 *                         type: string
 *                       title:
 *                         type: string
 *                       listItemId:
 *                         type: string
 */
app.get('/tabs', async (req, res) => {
  try {
    const userId = req.query.userId;
    const session = sessions.get(normalizeUserId(userId));
    
    if (!session) {
      return res.json({ running: true, tabs: [] });
    }
    
    const tabs = [];
    for (const [listItemId, group] of session.tabGroups) {
      for (const [tabId, tabState] of group) {
        tabs.push({
          targetId: tabId,
          tabId,
          url: tabState.page.url(),
          title: await tabState.page.title().catch(() => ''),
          listItemId
        });
      }
    }
    
    res.json({ running: true, tabs });
  } catch (err) {
    log('error', 'list tabs failed', { reqId: req.reqId, error: err.message });
    handleRouteError(err, req, res);
  }
});

// POST /tabs/open - Open tab (alias for POST /tabs, OpenClaw format)
/**
 * @openapi
 * /tabs/open:
 *   post:
 *     tags: [Legacy]
 *     summary: Open tab (OpenClaw format)
 *     deprecated: true
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [userId, url]
 *             properties:
 *               userId:
 *                 type: string
 *               url:
 *                 type: string
 *               listItemId:
 *                 type: string
 *     responses:
 *       200:
 *         description: Tab opened.
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *       400:
 *         description: Bad request.
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 */
app.post('/tabs/open', async (req, res) => {
  try {
    const { url, userId, listItemId = 'default' } = req.body;
    if (!userId) {
      return res.status(400).json({ error: 'userId is required' });
    }
    if (!url) {
      return res.status(400).json({ error: 'url is required' });
    }
    
    const urlErr = validateUrl(url);
    if (urlErr) return res.status(400).json({ error: urlErr });
    
    const session = await getSession(userId);
    
    // Recycle oldest tab when limits are reached instead of rejecting
    let totalTabs = 0;
    for (const g of session.tabGroups.values()) totalTabs += g.size;
    if (totalTabs >= MAX_TABS_PER_SESSION || getTotalTabCount() >= MAX_TABS_GLOBAL) {
      const recycled = await recycleOldestTab(session, req.reqId, userId);
      if (!recycled) {
        return res.status(429).json({ error: 'Maximum tabs per session reached' });
      }
    }
    
    const group = getTabGroup(session, listItemId);
    
    const page = await session.context.newPage();
    const tabId = fly.makeTabId();
    const tabState = createTabState(page);
    attachDownloadListener(tabState, tabId, log, pluginEvents, userId);
    group.set(tabId, tabState);
    refreshActiveTabsGauge();
    
    await withPageLoadDuration('open_url', () => page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 }));
    tabState.visitedUrls.add(url);
    
    log('info', 'openclaw tab opened', { reqId: req.reqId, tabId, url: page.url() });
    res.json({ 
      ok: true,
      targetId: tabId,
      tabId,
      url: page.url(),
      title: await page.title().catch(() => '')
    });
  } catch (err) {
    log('error', 'openclaw tab open failed', { reqId: req.reqId, error: err.message });
    handleRouteError(err, req, res);
  }
});

// POST /start - Start browser (OpenClaw expects this)
/**
 * @openapi
 * /start:
 *   post:
 *     tags: [Browser]
 *     summary: Start browser
 *     description: Ensures the browser process is running. Idempotent.
 *     responses:
 *       200:
 *         description: Browser started.
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 ok:
 *                   type: boolean
 *                 profile:
 *                   type: string
 *       500:
 *         description: Launch failed.
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 */
app.post('/start', async (req, res) => {
  try {
    await ensureBrowser();
    res.json({ ok: true, profile: 'camoufox' });
  } catch (err) {
    failuresTotal.labels('browser_launch', 'start').inc();
    res.status(500).json({ ok: false, error: safeError(err) });
  }
});

// POST /stop - Stop browser (OpenClaw expects this)
/**
 * @openapi
 * /stop:
 *   post:
 *     tags: [Browser]
 *     summary: Stop browser
 *     description: Stops the browser and closes all sessions. Requires x-admin-key header.
 *     security:
 *       - BearerAuth: []
 *     responses:
 *       200:
 *         description: Browser stopped.
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 ok:
 *                   type: boolean
 *                 stopped:
 *                   type: boolean
 *                 profile:
 *                   type: string
 *       403:
 *         description: Forbidden.
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 */
app.post('/stop', async (req, res) => {
  try {
    const adminKey = req.headers['x-admin-key'];
    if (!adminKey || !timingSafeCompare(adminKey, CONFIG.adminKey)) {
      return res.status(403).json({ error: 'Forbidden' });
    }
    await closeAllSessions('admin_stop', { clearDownloads: true, clearLocks: true });
    await closeBrowserFully('admin_stop');
    res.json({ ok: true, stopped: true, profile: 'camoufox' });
  } catch (err) {
    res.status(500).json({ ok: false, error: safeError(err) });
  }
});

// POST /navigate - Navigate (OpenClaw format with targetId in body)
/**
 * @openapi
 * /navigate:
 *   post:
 *     tags: [Legacy]
 *     summary: Navigate (OpenClaw format)
 *     description: Navigate with targetId in body instead of path param.
 *     deprecated: true
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [userId, url]
 *             properties:
 *               userId:
 *                 type: string
 *               targetId:
 *                 type: string
 *               url:
 *                 type: string
 *     responses:
 *       200:
 *         description: Navigation result.
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *       400:
 *         description: Bad request.
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *       404:
 *         description: Tab not found.
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 */
app.post('/navigate', async (req, res) => {
  try {
    const { targetId, url, userId } = req.body;
    if (!userId) {
      return res.status(400).json({ error: 'userId is required' });
    }
    if (!url) {
      return res.status(400).json({ error: 'url is required' });
    }
    
    const urlErr = validateUrl(url);
    if (urlErr) return res.status(400).json({ error: urlErr });
    
    const session = sessions.get(normalizeUserId(userId));
    const found = session && findTab(session, targetId);
    if (!found) {
      return res.status(404).json({ error: 'Tab not found' });
    }
    
    const { tabState } = found;
    tabState.toolCalls++; tabState.consecutiveTimeouts = 0; tabState.consecutiveFailures = 0;
    
    const result = await withTabLock(targetId, async () => {
      await withPageLoadDuration('navigate', () => tabState.page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 }));
      tabState.visitedUrls.add(url);
      tabState.lastSnapshot = null;
      
      // Google SERP: defer extraction to snapshot call
      if (isGoogleSerp(tabState.page.url())) {
        tabState.refs = new Map();
        return { ok: true, targetId, url: tabState.page.url(), googleSerp: true };
      }
      
      tabState.refs = await buildRefs(tabState.page);
      return { ok: true, targetId, url: tabState.page.url() };
    });
    
    res.json(result);
  } catch (err) {
    log('error', 'openclaw navigate failed', { reqId: req.reqId, error: err.message });
    handleRouteError(err, req, res);
  }
});

// GET /snapshot - Snapshot (OpenClaw format with query params)
/**
 * @openapi
 * /snapshot:
 *   get:
 *     tags: [Legacy]
 *     summary: Snapshot (OpenClaw format)
 *     description: Snapshot with targetId/userId as query params.
 *     deprecated: true
 *     parameters:
 *       - name: targetId
 *         in: query
 *         required: true
 *         schema:
 *           type: string
 *       - name: userId
 *         in: query
 *         required: true
 *         schema:
 *           type: string
 *       - name: format
 *         in: query
 *         schema:
 *           type: string
 *       - name: offset
 *         in: query
 *         schema:
 *           type: integer
 *       - name: includeScreenshot
 *         in: query
 *         schema:
 *           type: string
 *           enum: ['true', 'false']
 *     responses:
 *       200:
 *         description: Snapshot.
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *       400:
 *         description: Bad request.
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *       404:
 *         description: Tab not found.
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 */
app.get('/snapshot', async (req, res) => {
  try {
    const { targetId, userId, format = 'text' } = req.query;
    const offset = parseInt(req.query.offset) || 0;
    if (!userId) {
      return res.status(400).json({ error: 'userId is required' });
    }
    
    const session = sessions.get(normalizeUserId(userId));
    const found = session && findTab(session, targetId);
    if (!found) {
      return res.status(404).json({ error: 'Tab not found' });
    }
    
    const { tabState } = found;
    tabState.toolCalls++; tabState.consecutiveTimeouts = 0; tabState.consecutiveFailures = 0;

    // Cached chunk retrieval
    if (offset > 0 && tabState.lastSnapshot) {
      const win = windowSnapshot(tabState.lastSnapshot, offset);
      const response = { ok: true, format: 'aria', targetId, url: tabState.page.url(), snapshot: win.text, refsCount: tabState.refs.size, truncated: win.truncated, totalChars: win.totalChars, hasMore: win.hasMore, nextOffset: win.nextOffset };
      if (req.query.includeScreenshot === 'true') {
        const pngBuffer = await tabState.page.screenshot({ type: 'png' });
        response.screenshot = { data: pngBuffer.toString('base64'), mimeType: 'image/png' };
      }
      return res.json(response);
    }

    const pageUrl = tabState.page.url();
    
    // Google SERP fast path
    if (isGoogleSerp(pageUrl)) {
      const { refs: googleRefs, snapshot: googleSnapshot } = await extractGoogleSerp(tabState.page);
      tabState.refs = googleRefs;
      tabState.lastSnapshot = googleSnapshot;
      snapshotBytes.labels('google_serp').observe(Buffer.byteLength(googleSnapshot, 'utf8'));
      const annotatedYaml = googleSnapshot;
      const win = windowSnapshot(annotatedYaml, 0);
      const response = {
        ok: true, format: 'aria', targetId, url: pageUrl,
        snapshot: win.text, refsCount: tabState.refs.size,
        truncated: win.truncated, totalChars: win.totalChars,
        hasMore: win.hasMore, nextOffset: win.nextOffset,
      };
      if (req.query.includeScreenshot === 'true') {
        const pngBuffer = await tabState.page.screenshot({ type: 'png' });
        response.screenshot = { data: pngBuffer.toString('base64'), mimeType: 'image/png' };
      }
      return res.json(response);
    }
    
    tabState.refs = await buildRefs(tabState.page);
    
    const ariaYaml = await getAriaSnapshot(tabState.page);
    
    // Annotate YAML with ref IDs
    let annotatedYaml = ariaYaml || '';
    if (annotatedYaml && tabState.refs.size > 0) {
      const refsByKey = new Map();
      for (const [refId, el] of tabState.refs) {
        const key = `${el.role}:${el.name || ''}`;
        if (!refsByKey.has(key)) refsByKey.set(key, refId);
      }
      
      const lines = annotatedYaml.split('\n');
      annotatedYaml = lines.map(line => {
        const match = line.match(/^(\s*)-\s+(\w+)(?:\s+"([^"]*)")?/);
        if (match) {
          const [, indent, role, name] = match;
          const key = `${role}:${name || ''}`;
          const refId = refsByKey.get(key);
          if (refId) {
            return line.replace(/^(\s*-\s+\w+)/, `$1 [${refId}]`);
          }
        }
        return line;
      }).join('\n');
    }
    
    tabState.lastSnapshot = annotatedYaml;
    if (annotatedYaml) snapshotBytes.labels('full').observe(Buffer.byteLength(annotatedYaml, 'utf8'));
    const win = windowSnapshot(annotatedYaml, 0);

    const response = {
      ok: true,
      format: 'aria',
      targetId,
      url: tabState.page.url(),
      snapshot: win.text,
      refsCount: tabState.refs.size,
      truncated: win.truncated,
      totalChars: win.totalChars,
      hasMore: win.hasMore,
      nextOffset: win.nextOffset,
    };

    if (req.query.includeScreenshot === 'true') {
      const pngBuffer = await tabState.page.screenshot({ type: 'png' });
      response.screenshot = { data: pngBuffer.toString('base64'), mimeType: 'image/png' };
    }

    res.json(response);
  } catch (err) {
    log('error', 'openclaw snapshot failed', { reqId: req.reqId, error: err.message });
    handleRouteError(err, req, res);
  }
});

// POST /act - Combined action endpoint (OpenClaw format)
// Routes to click/type/scroll/press/etc based on 'kind' parameter
/**
 * @openapi
 * /act:
 *   post:
 *     tags: [Legacy]
 *     summary: Combined action (OpenClaw format)
 *     description: Routes to click/type/scroll/press/etc based on "kind" parameter.
 *     deprecated: true
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [userId, kind]
 *             properties:
 *               userId:
 *                 type: string
 *               kind:
 *                 type: string
 *                 description: 'Action kind: click, type, scroll, press, key, select_option, drag, hover, screenshot, wait, back, forward.'
 *               targetId:
 *                 type: string
 *               ref:
 *                 type: string
 *               selector:
 *                 type: string
 *               text:
 *                 type: string
 *               key:
 *                 type: string
 *               direction:
 *                 type: string
 *               url:
 *                 type: string
 *     responses:
 *       200:
 *         description: Action result.
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *       400:
 *         description: Bad request.
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *       404:
 *         description: Tab not found.
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 */
app.post('/act', async (req, res) => {
  try {
    const { kind, targetId, userId, ...params } = req.body;
    if (!userId) {
      return res.status(400).json({ error: 'userId is required' });
    }
    
    if (!kind) {
      return res.status(400).json({ error: 'kind is required' });
    }
    
    const session = sessions.get(normalizeUserId(userId));
    const found = session && findTab(session, targetId);
    if (!found) {
      return res.status(404).json({ error: 'Tab not found' });
    }
    
    const { tabState } = found;
    tabState.toolCalls++; tabState.consecutiveTimeouts = 0; tabState.consecutiveFailures = 0;
    
    const result = await withTabLock(targetId, async () => {
      switch (kind) {
        case 'click': {
          const { ref, selector, doubleClick } = params;
          if (!ref && !selector) {
            throw new Error('ref or selector required');
          }
          
          const doClick = async (locatorOrSelector, isLocator) => {
            const locator = isLocator ? locatorOrSelector : tabState.page.locator(locatorOrSelector);
            const clickOpts = { timeout: 3000 };
            if (doubleClick) clickOpts.clickCount = 2;
            
            try {
              await locator.click(clickOpts);
            } catch (err) {
              if (err.message.includes('intercepts pointer events')) {
                await locator.click({ ...clickOpts, force: true });
              } else {
                throw err;
              }
            }
          };
          
          if (ref) {
            let locator = refToLocator(tabState.page, ref, tabState.refs);
            if (!locator) {
              log('info', 'auto-refreshing refs before click (openclaw)', { ref, hadRefs: tabState.refs.size });
              tabState.refs = await buildRefs(tabState.page);
              locator = refToLocator(tabState.page, ref, tabState.refs);
            }
            if (!locator) { const maxRef = tabState.refs.size > 0 ? `e${tabState.refs.size}` : 'none'; throw new StaleRefsError(ref, maxRef, tabState.refs.size); }
            await doClick(locator, true);
          } else {
            await doClick(selector, false);
          }
          
          await tabState.page.waitForTimeout(500);
          tabState.refs = await buildRefs(tabState.page);
          return { ok: true, targetId, url: tabState.page.url() };
        }
        
        case 'type': {
          const { ref, selector, text, submit, mode = 'fill', delay = 30 } = params;
          if (mode === 'fill' && !ref && !selector) {
            throw new Error('ref or selector required for mode=fill');
          }
          if (typeof text !== 'string') {
            throw new Error('text is required');
          }
          if (mode !== 'fill' && mode !== 'keyboard') {
            throw new Error("mode must be 'fill' or 'keyboard'");
          }
          
          let locator = null;
          if (ref) {
            locator = refToLocator(tabState.page, ref, tabState.refs);
            if (!locator) {
              log('info', 'auto-refreshing refs before type (openclaw)', { ref, hadRefs: tabState.refs.size, mode });
              tabState.refs = await buildRefs(tabState.page);
              locator = refToLocator(tabState.page, ref, tabState.refs);
            }
            if (!locator) { const maxRef = tabState.refs.size > 0 ? `e${tabState.refs.size}` : 'none'; throw new StaleRefsError(ref, maxRef, tabState.refs.size); }
          }
          
          if (mode === 'fill') {
            if (locator) {
              await locator.fill(text, { timeout: 10000 });
            } else {
              await tabState.page.fill(selector, text, { timeout: 10000 });
            }
          } else {
            if (locator) {
              await locator.focus({ timeout: 10000 });
            } else if (selector) {
              await tabState.page.focus(selector, { timeout: 10000 });
            }
            await tabState.page.keyboard.type(text, { delay });
          }
          if (submit) await tabState.page.keyboard.press('Enter');
          return { ok: true, targetId };
        }
        
        case 'press': {
          const { key } = params;
          if (!key) throw new Error('key is required');
          await tabState.page.keyboard.press(key);
          return { ok: true, targetId };
        }
        
        case 'scroll':
        case 'scrollIntoView': {
          const { ref, direction = 'down', amount = 500 } = params;
          if (ref) {
            let locator = refToLocator(tabState.page, ref, tabState.refs);
            if (!locator) {
              tabState.refs = await buildRefs(tabState.page);
              locator = refToLocator(tabState.page, ref, tabState.refs);
            }
            if (!locator) { const maxRef = tabState.refs.size > 0 ? `e${tabState.refs.size}` : 'none'; throw new StaleRefsError(ref, maxRef, tabState.refs.size); }
            await locator.scrollIntoViewIfNeeded({ timeout: 5000 });
          } else {
            const isVertical = direction === 'up' || direction === 'down';
            const delta = (direction === 'up' || direction === 'left') ? -amount : amount;
            await tabState.page.mouse.wheel(isVertical ? 0 : delta, isVertical ? delta : 0);
          }
          await tabState.page.waitForTimeout(300);
          return { ok: true, targetId };
        }
        
        case 'hover': {
          const { ref, selector } = params;
          if (!ref && !selector) throw new Error('ref or selector required');
          
          if (ref) {
            let locator = refToLocator(tabState.page, ref, tabState.refs);
            if (!locator) {
              tabState.refs = await buildRefs(tabState.page);
              locator = refToLocator(tabState.page, ref, tabState.refs);
            }
            if (!locator) { const maxRef = tabState.refs.size > 0 ? `e${tabState.refs.size}` : 'none'; throw new StaleRefsError(ref, maxRef, tabState.refs.size); }
            await locator.hover({ timeout: 5000 });
          } else {
            await tabState.page.locator(selector).hover({ timeout: 5000 });
          }
          return { ok: true, targetId };
        }
        
        case 'wait': {
          const { timeMs, text, loadState } = params;
          if (timeMs) {
            await tabState.page.waitForTimeout(timeMs);
          } else if (text) {
            await tabState.page.waitForSelector(`text=${text}`, { timeout: 30000 });
          } else if (loadState) {
            await tabState.page.waitForLoadState(loadState, { timeout: 30000 });
          }
          return { ok: true, targetId, url: tabState.page.url() };
        }
        
        case 'close': {
          await safePageClose(tabState.page);
          found.group.delete(targetId);
          { const _l = tabLocks.get(targetId); if (_l) _l.drain(); tabLocks.delete(targetId); }
          return { ok: true, targetId };
        }
        
        default:
          throw new Error(`Unsupported action kind: ${kind}`);
      }
    });
    
    res.json(result);
  } catch (err) {
    log('error', 'act failed', { reqId: req.reqId, kind: req.body?.kind, error: err.message });
    handleRouteError(err, req, res);
  }
});

// Periodic stats beacon (every 5 min)
setInterval(() => {
  const mem = process.memoryUsage();
  let totalTabs = 0;
  for (const [, session] of sessions) {
    for (const [, group] of session.tabGroups) {
      totalTabs += group.size;
    }
  }
  log('info', 'stats', {
    sessions: sessions.size,
    tabs: totalTabs,
    rssBytes: mem.rss,
    heapUsedBytes: mem.heapUsed,
    uptimeSeconds: Math.floor(process.uptime()),
    browserConnected: browser?.isConnected() ?? false,
  });
}, 5 * 60_000);

// Active health probe -- detect hung browser even when isConnected() lies
setInterval(async () => {
  if (!browser || healthState.isRecovering) return;
  const timeSinceSuccess = Date.now() - healthState.lastSuccessfulNav;
  // Skip probe if operations are in flight AND last success was recent.
  // If it's been >120s since any successful operation, probe anyway --
  // active ops are likely stuck on a frozen browser and will time out eventually.
  if (healthState.activeOps > 0 && timeSinceSuccess < 120000) {
    log('info', 'health probe skipped, operations active', { activeOps: healthState.activeOps });
    return;
  }
  if (timeSinceSuccess < 120000) return;
  
  if (healthState.activeOps > 0) {
    log('warn', 'health probe forced despite active ops', { activeOps: healthState.activeOps, timeSinceSuccessMs: timeSinceSuccess });
  }
  
  let testContext;
  try {
    testContext = await browser.newContext();
    const page = await testContext.newPage();
    await page.goto('about:blank', { timeout: 5000 });
    await page.close();
    await testContext.close();
    healthState.lastSuccessfulNav = Date.now();
  } catch (err) {
    failuresTotal.labels('health_probe', 'internal').inc();
    log('warn', 'health probe failed', { error: err.message, timeSinceSuccessMs: timeSinceSuccess });
    if (testContext) await testContext.close().catch(() => {});
    restartBrowser('health probe failed').catch(() => {});
  }
}, 60_000);

// Crash logging
process.on('uncaughtException', (err) => {
  pluginEvents.emit('browser:error', { error: err });
  log('error', 'uncaughtException', { error: err.message, stack: err.stack });
  reporter.reportCrash(err, { resourceOpts: _resourceOpts() });
  process.exit(1);
});
process.on('unhandledRejection', (reason) => {
  log('error', 'unhandledRejection', { reason: String(reason) });
});

// Graceful shutdown
let shuttingDown = false;

async function gracefulShutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  log('info', 'shutting down', { signal });
  pluginEvents.emit('server:shutdown', { signal });

  const forceTimeout = setTimeout(() => {
    log('error', 'shutdown timed out, forcing exit');
    process.exit(1);
  }, 10000);
  forceTimeout.unref();

  server.close();
  stopMemoryReporter();

  await closeAllSessions(`shutdown:${signal}`, {
    clearDownloads: false,
    clearLocks: false,
  });

  await closeBrowserFully(`shutdown:${signal}`);
  process.exit(0);
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

// Idle self-shutdown REMOVED -- it was racing with min_machines_running=2
// and stopping machines that Fly couldn't auto-restart fast enough, leaving
// only 1 machine to handle all browser traffic (causing timeouts for users).
// Fly's auto_stop_machines=false + min_machines_running=2 handles scaling.

const PORT = CONFIG.port;
pluginEvents.emit('server:starting', { port: PORT });

// Load plugins before starting the server
const pluginCtx = {
  sessions,
  config: CONFIG,
  log,
  events: pluginEvents,
  auth: authMiddleware,
  ensureBrowser,
  getSession,
  destroySession,
  closeSession,
  withUserLimit,
  safePageClose,
  normalizeUserId,
  validateUrl,
  safeError,
  buildProxyUrl,
  proxyPool,
  failuresTotal,
  metricsRegistry: getRegister,
  createMetric,
  /** Factory for Xvfb virtual display. Plugins can replace this to customise resolution/args. */
  createVirtualDisplay: () => new VirtualDisplay(),
  /** The upstream VirtualDisplay class -- plugins can subclass it. */
  VirtualDisplay,
};
const loadedPlugins = await loadPlugins(app, pluginCtx);

// --- OpenAPI docs (after all routes are registered) ---
mountDocs(app);

const server = app.listen(PORT, async () => {
  startMemoryReporter();
  refreshActiveTabsGauge();
  refreshTabLockQueueDepth();
  pluginEvents.emit('server:started', { port: PORT, pid: process.pid, plugins: loadedPlugins });
  if (FLY_MACHINE_ID) {
    log('info', 'server started (fly)', { port: PORT, pid: process.pid, machineId: FLY_MACHINE_ID, nodeVersion: process.version });
  } else {
    log('info', 'server started', { port: PORT, pid: process.pid, nodeVersion: process.version });
  }
  const tmpCleanup = cleanupOrphanedTempFiles({ tmpDir: os.tmpdir() });
  if (tmpCleanup.removed > 0) {
    log('info', 'cleaned up orphaned camoufox temp files', tmpCleanup);
  }
  const profileCleanup = cleanupStaleFirefoxProfiles();
  if (profileCleanup.removed > 0) {
    log('info', 'cleaned up stale firefox profiles on startup', profileCleanup);
  }

  // Periodic temp profile cleanup every 10 minutes
  setInterval(() => {
    try {
      const cleaned = cleanupStaleFirefoxProfiles();
      if (cleaned.removed > 0) {
        log('info', 'periodic firefox profile cleanup', cleaned);
      }
    } catch { /* best effort */ }
  }, 10 * 60 * 1000).unref();
  const traceSweep = sweepOldTraces({
    baseDir: CONFIG.tracesDir,
    ttlMs: CONFIG.tracesTtlHours * 3600 * 1000,
    maxBytesPerFile: CONFIG.tracesMaxBytes,
  });
  if (traceSweep.removedTtl > 0 || traceSweep.removedOversized > 0) {
    log('info', 'swept old traces', traceSweep);
  }
  // Pre-warm browser so first request doesn't eat a 6-7s cold start
  try {
    const start = Date.now();
    await ensureBrowser();
    log('info', 'browser pre-warmed', { ms: Date.now() - start });
    scheduleBrowserIdleShutdown();
  } catch (err) {
    if (isFatalInstallError(err)) {
      log('error', 'browser pre-warm aborted: Camoufox binaries are not installed', {
        error: err.message,
        remediation: 'run `npx camoufox-js fetch` then restart the server',
      });
    } else {
      log('error', 'browser pre-warm failed (will retry in background)', { error: err.message });
      scheduleBrowserWarmRetry();
    }
  }
  // Idle self-shutdown removed -- Fly manages machine lifecycle via fly.toml.
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    log('error', 'port in use', { port: PORT });
    process.exit(1);
  }
  log('error', 'server error', { error: err.message });
  process.exit(1);
});
