const { Camoufox, launchOptions } = require('camoufox-js');
const { firefox } = require('playwright-core');
const express = require('express');
const crypto = require('crypto');
const os = require('os');
const { expandMacro } = require('./lib/macros');
const { loadConfig } = require('./lib/config');
const { windowSnapshot } = require('./lib/snapshot');

const CONFIG = loadConfig();

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

// Request logging middleware
app.use((req, res, next) => {
  if (req.path === '/health') return next();
  const reqId = crypto.randomUUID().slice(0, 8);
  req.reqId = reqId;
  req.startTime = Date.now();
  const userId = req.body?.userId || req.query?.userId || '-';
  log('info', 'req', { reqId, method: req.method, path: req.path, userId });
  const origEnd = res.end.bind(res);
  res.end = function (...args) {
    const ms = Date.now() - req.startTime;
    log('info', 'res', { reqId, status: res.statusCode, ms });
    return origEnd(...args);
  };
  next();
});

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

function timingSafeCompare(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) {
    crypto.timingSafeEqual(bufA, bufA);
    return false;
  }
  return crypto.timingSafeEqual(bufA, bufB);
}

function safeError(err) {
  if (CONFIG.nodeEnv === 'production') {
    log('error', 'internal error', { error: err.message, stack: err.stack });
    return 'Internal server error';
  }
  return err.message;
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

// Import cookies into a user's browser context (Playwright cookies format)
// POST /sessions/:userId/cookies { cookies: Cookie[] }
//
// SECURITY:
// Cookie injection moves this from "anonymous browsing" to "authenticated browsing".
// This endpoint is DISABLED unless CAMOFOX_API_KEY is set.
// When enabled, caller must send: Authorization: Bearer <CAMOFOX_API_KEY>
app.post('/sessions/:userId/cookies', express.json({ limit: '512kb' }), async (req, res) => {
  try {
    if (!CONFIG.apiKey) {
      return res.status(403).json({
        error: 'Cookie import is disabled. Set CAMOFOX_API_KEY to enable this endpoint.',
      });
    }
    const apiKey = CONFIG.apiKey;

    const auth = String(req.headers['authorization'] || '');
    const match = auth.match(/^Bearer\s+(.+)$/i);
    if (!match || !timingSafeCompare(match[1], apiKey)) {
      return res.status(403).json({ error: 'Forbidden' });
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
    res.json(result);
  } catch (err) {
    log('error', 'cookie import failed', { reqId: req.reqId, error: err.message });
    res.status(500).json({ error: safeError(err) });
  }
});

let browser = null;
// userId -> { context, tabGroups: Map<sessionKey, Map<tabId, TabState>>, lastAccess }
// TabState = { page, refs: Map<refId, {role, name, nth}>, visitedUrls: Set, toolCalls: number }
// Note: sessionKey was previously called listItemId - both are accepted for backward compatibility
const sessions = new Map();

const SESSION_TIMEOUT_MS = parseInt(process.env.SESSION_TIMEOUT_MS) || 1800000; // 30 min
const MAX_SNAPSHOT_NODES = 500;
const MAX_SESSIONS = parseInt(process.env.MAX_SESSIONS) || 50;
const MAX_TABS_PER_SESSION = parseInt(process.env.MAX_TABS_PER_SESSION) || 10;
const MAX_TABS_GLOBAL = parseInt(process.env.MAX_TABS_GLOBAL) || 10;
const HANDLER_TIMEOUT_MS = parseInt(process.env.HANDLER_TIMEOUT_MS) || 30000;
const MAX_CONCURRENT_PER_USER = parseInt(process.env.MAX_CONCURRENT_PER_USER) || 3;
const PAGE_CLOSE_TIMEOUT_MS = 5000;
const NAVIGATE_TIMEOUT_MS = parseInt(process.env.NAVIGATE_TIMEOUT_MS) || 25000;
const BUILDREFS_TIMEOUT_MS = parseInt(process.env.BUILDREFS_TIMEOUT_MS) || 12000;
const FAILURE_THRESHOLD = 3;
const TAB_LOCK_TIMEOUT_MS = 30000;

// Per-tab locks to serialize operations on the same tab
// tabId -> Promise (the currently executing operation)
const tabLocks = new Map();

async function withTabLock(tabId, operation) {
  // Wait for any pending operation on this tab to complete
  const pending = tabLocks.get(tabId);
  if (pending) {
    try {
      await Promise.race([
        pending,
        new Promise((_, reject) => setTimeout(() => reject(new Error('Tab lock timeout')), TAB_LOCK_TIMEOUT_MS))
      ]);
    } catch (e) {
      if (e.message === 'Tab lock timeout') {
        log('warn', 'tab lock timeout, proceeding', { tabId });
      }
    }
  }
  
  // Execute this operation and store the promise
  const promise = operation();
  tabLocks.set(tabId, promise);
  
  try {
    return await promise;
  } finally {
    // Clean up if this is still the active lock
    if (tabLocks.get(tabId) === promise) {
      tabLocks.delete(tabId);
    }
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

function buildProxyConfig() {
  const { host, port, username, password } = CONFIG.proxy;
  
  if (!host || !port) {
    log('info', 'no proxy configured');
    return null;
  }
  
  log('info', 'proxy configured', { host, port });
  return {
    server: `http://${host}:${port}`,
    username,
    password,
  };
}

const BROWSER_IDLE_TIMEOUT_MS = parseInt(process.env.BROWSER_IDLE_TIMEOUT_MS) || 300000; // 5 min
let browserIdleTimer = null;
let browserLaunchPromise = null;

function scheduleBrowserIdleShutdown() {
  clearBrowserIdleTimer();
  if (sessions.size === 0 && browser) {
    browserIdleTimer = setTimeout(async () => {
      if (sessions.size === 0 && browser) {
        log('info', 'browser idle shutdown (no sessions)');
        const b = browser;
        browser = null;
        await b.close().catch(() => {});
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
  log('error', 'restarting browser', { reason, failures: healthState.consecutiveNavFailures });
  try {
    for (const [, session] of sessions) {
      await session.context.close().catch(() => {});
    }
    sessions.clear();
    if (browser) {
      await browser.close().catch(() => {});
      browser = null;
    }
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

async function launchBrowserInstance() {
  const hostOS = getHostOS();
  const proxy = buildProxyConfig();
  
  log('info', 'launching camoufox', { hostOS, geoip: !!proxy });
  
  const options = await launchOptions({
    headless: true,
    os: hostOS,
    humanize: true,
    enable_cache: true,
    proxy: proxy,
    geoip: !!proxy,
  });
  
  browser = await firefox.launch(options);
  log('info', 'camoufox launched');
  return browser;
}

async function ensureBrowser() {
  clearBrowserIdleTimer();
  if (browser && !browser.isConnected()) {
    log('warn', 'browser disconnected, clearing dead sessions and relaunching', {
      deadSessions: sessions.size,
    });
    for (const [userId, session] of sessions) {
      await session.context.close().catch(() => {});
    }
    sessions.clear();
    browser = null;
  }
  if (browser) return browser;
  if (browserLaunchPromise) return browserLaunchPromise;
  browserLaunchPromise = Promise.race([
    launchBrowserInstance(),
    new Promise((_, reject) => setTimeout(() => reject(new Error('Browser launch timeout (30s)')), 30000)),
  ]).finally(() => { browserLaunchPromise = null; });
  return browserLaunchPromise;
}

// Helper to normalize userId to string (JSON body may parse as number)
function normalizeUserId(userId) {
  return String(userId);
}

async function getSession(userId) {
  const key = normalizeUserId(userId);
  let session = sessions.get(key);
  if (!session) {
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
    const context = await b.newContext(contextOptions);
    
    session = { context, tabGroups: new Map(), lastAccess: Date.now() };
    sessions.set(key, session);
    log('info', 'session created', { userId: key });
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
  return {
    page,
    refs: new Map(),
    visitedUrls: new Set(),
    toolCalls: 0,
    lastSnapshot: null,
  };
}

async function waitForPageReady(page, options = {}) {
  const { timeout = 10000, waitForNetwork = true } = options;
  
  try {
    await page.waitForLoadState('domcontentloaded', { timeout });
    
    if (waitForNetwork) {
      await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {
        log('warn', 'networkidle timeout, continuing');
      });
    }
    
    // Framework hydration wait (React/Next.js/Vue) - mirrors Swift WebView.swift logic
    // Wait for readyState === 'complete' + network quiet (40 iterations × 250ms max)
    await page.evaluate(async () => {
      for (let i = 0; i < 40; i++) {
        // Check if network is quiet (no recent resource loads)
        const entries = performance.getEntriesByType('resource');
        const recentEntries = entries.slice(-5);
        const netQuiet = recentEntries.every(e => (performance.now() - e.responseEnd) > 400);
        
        if (document.readyState === 'complete' && netQuiet) {
          // Double RAF to ensure paint is complete
          await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
          break;
        }
        await new Promise(r => setTimeout(r, 250));
      }
    }).catch(() => {
      log('warn', 'hydration wait failed, continuing');
    });
    
    await page.waitForTimeout(200);
    
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

async function buildRefs(page) {
  const refs = new Map();
  
  if (!page || page.isClosed()) {
    log('warn', 'buildRefs: page closed or invalid');
    return refs;
  }
  
  const start = Date.now();
  
  // Hard total timeout on the entire buildRefs operation
  const timeoutPromise = new Promise((_, reject) => 
    setTimeout(() => reject(new Error('buildRefs_timeout')), BUILDREFS_TIMEOUT_MS)
  );
  
  try {
    return await Promise.race([
      _buildRefsInner(page, refs, start),
      timeoutPromise
    ]);
  } catch (err) {
    if (err.message === 'buildRefs_timeout') {
      log('warn', 'buildRefs: total timeout exceeded', { elapsed: Date.now() - start });
      return refs;
    }
    throw err;
  }
}

async function _buildRefsInner(page, refs, start) {
  await waitForPageReady(page, { waitForNetwork: false });
  
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
  await waitForPageReady(page, { waitForNetwork: false });
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

// Health check (passive — does not launch browser)
// --- YouTube transcript extraction ---
// POST /youtube/transcript { url, userId? }
// Navigates to the YouTube page with Camoufox anti-detection,
// extracts caption track URLs from the embedded player response,
// fetches and parses the transcript, returns it in one call.
app.post('/youtube/transcript', async (req, res) => {
  const reqId = req.reqId;
  try {
    const { url, userId = '__yt_transcript__', languages = ['en'] } = req.body;
    if (!url) return res.status(400).json({ error: 'url is required' });

    const urlErr = validateUrl(url);
    if (urlErr) return res.status(400).json({ error: urlErr });

    const videoIdMatch = url.match(
      /(?:youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/embed\/|youtube\.com\/shorts\/)([a-zA-Z0-9_-]{11})/
    );
    if (!videoIdMatch) {
      return res.status(400).json({ error: 'Could not extract YouTube video ID from URL' });
    }
    const videoId = videoIdMatch[1];

    log('info', 'youtube transcript: starting', { reqId, videoId, url });

    const result = await withUserLimit(userId, async () => {
      await ensureBrowser();
      const session = await getSession(userId);
      const page = await session.context.newPage();

      try {
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: NAVIGATE_TIMEOUT_MS });
        await page.waitForTimeout(2000);

        const captionData = await page.evaluate((preferredLangs) => {
          const playerResponse =
            window.ytInitialPlayerResponse ||
            (typeof ytInitialPlayerResponse !== 'undefined' ? ytInitialPlayerResponse : null);

          if (!playerResponse) {
            const scripts = document.querySelectorAll('script');
            for (const script of scripts) {
              const text = script.textContent || '';
              const match = text.match(/ytInitialPlayerResponse\s*=\s*(\{.+?\});/s);
              if (match) {
                try {
                  const parsed = JSON.parse(match[1]);
                  return extractCaptions(parsed, preferredLangs);
                } catch (e) { /* continue */ }
              }
            }
            return { error: 'no_player_response' };
          }

          return extractCaptions(playerResponse, preferredLangs);

          function extractCaptions(response, langs) {
            const title = response?.videoDetails?.title || '';
            const captions = response?.captions;
            if (!captions) return { error: 'no_captions', title };

            const renderer = captions.playerCaptionsTracklistRenderer;
            if (!renderer) return { error: 'no_caption_renderer', title };

            const tracks = renderer.captionTracks || [];
            if (tracks.length === 0) return { error: 'no_caption_tracks', title };

            let bestTrack = null;
            for (const lang of langs) {
              for (const track of tracks) {
                if (track.languageCode === lang && !track.kind) { bestTrack = track; break; }
              }
              if (bestTrack) break;
              for (const track of tracks) {
                if (track.languageCode === lang) { bestTrack = track; break; }
              }
              if (bestTrack) break;
            }
            if (!bestTrack) bestTrack = tracks[0];

            return {
              title,
              captionUrl: bestTrack.baseUrl,
              languageCode: bestTrack.languageCode,
              kind: bestTrack.kind || 'manual',
              availableLanguages: tracks.map(t => ({
                code: t.languageCode,
                name: t.name?.simpleText || t.languageCode,
                kind: t.kind || 'manual',
              })),
            };
          }
        }, languages);

        log('info', 'youtube transcript: caption data extracted', {
          reqId, videoId, hasUrl: !!captionData?.captionUrl, error: captionData?.error,
          title: captionData?.title?.slice(0, 50),
        });

        if (captionData.error) {
          return {
            status: 'error', code: 404,
            message: `YouTube captions not available: ${captionData.error}`,
            video_url: url, video_id: videoId, title: captionData.title || '',
          };
        }

        const captionUrl = captionData.captionUrl;
        let transcriptText = null;

        // Try JSON3 format first
        try {
          const json3Url = captionUrl.includes('?') ? `${captionUrl}&fmt=json3` : `${captionUrl}?fmt=json3`;
          const json3Resp = await page.evaluate(async (fetchUrl) => {
            const resp = await fetch(fetchUrl);
            return resp.ok ? await resp.text() : null;
          }, json3Url);
          if (json3Resp) transcriptText = parseJson3(json3Resp);
        } catch (e) {
          log('warn', 'youtube transcript: json3 fetch failed', { reqId, error: e.message });
        }

        // Fallback to VTT
        if (!transcriptText) {
          try {
            const vttUrl = captionUrl.includes('?') ? `${captionUrl}&fmt=vtt` : `${captionUrl}?fmt=vtt`;
            const vttResp = await page.evaluate(async (fetchUrl) => {
              const resp = await fetch(fetchUrl);
              return resp.ok ? await resp.text() : null;
            }, vttUrl);
            if (vttResp) transcriptText = parseVtt(vttResp);
          } catch (e) {
            log('warn', 'youtube transcript: vtt fetch failed', { reqId, error: e.message });
          }
        }

        // Final fallback: raw XML
        if (!transcriptText) {
          try {
            const xmlResp = await page.evaluate(async (fetchUrl) => {
              const resp = await fetch(fetchUrl);
              return resp.ok ? await resp.text() : null;
            }, captionUrl);
            if (xmlResp) transcriptText = parseXml(xmlResp);
          } catch (e) {
            log('warn', 'youtube transcript: xml fetch failed', { reqId, error: e.message });
          }
        }

        if (!transcriptText || !transcriptText.trim()) {
          return {
            status: 'error', code: 404,
            message: 'Caption URL found but transcript content was empty',
            video_url: url, video_id: videoId, title: captionData.title || '',
          };
        }

        return {
          status: 'ok', transcript: transcriptText,
          video_url: url, video_id: videoId, video_title: captionData.title || '',
          language: captionData.languageCode, caption_kind: captionData.kind,
          total_words: transcriptText.split(/\s+/).length,
          available_languages: captionData.availableLanguages,
        };
      } finally {
        await safePageClose(page);
      }
    });

    log('info', 'youtube transcript: done', { reqId, videoId, status: result.status, words: result.total_words });
    res.json(result);
  } catch (err) {
    log('error', 'youtube transcript failed', { reqId, error: err.message, stack: err.stack });
    res.status(500).json({ error: safeError(err) });
  }
});

// --- YouTube transcript parsers ---

function parseJson3(content) {
  try {
    const data = JSON.parse(content);
    const events = data.events || [];
    const lines = [];
    for (const event of events) {
      const segs = event.segs || [];
      if (!segs.length) continue;
      const text = segs.map(s => s.utf8 || '').join('').trim();
      if (!text) continue;
      const tsMs = event.tStartMs || 0;
      const tsSec = Math.floor(tsMs / 1000);
      const mm = Math.floor(tsSec / 60);
      const ss = tsSec % 60;
      lines.push(`[${String(mm).padStart(2, '0')}:${String(ss).padStart(2, '0')}] ${text}`);
    }
    return lines.join('\n');
  } catch (e) {
    return null;
  }
}

function parseVtt(content) {
  const lines = content.split('\n');
  const result = [];
  let currentTimestamp = '';
  for (const line of lines) {
    const stripped = line.trim();
    if (!stripped || stripped === 'WEBVTT' || stripped.startsWith('Kind:') || stripped.startsWith('Language:') || stripped.startsWith('NOTE')) continue;
    if (stripped.includes(' --> ')) {
      const parts = stripped.split(' --> ');
      if (parts[0]) currentTimestamp = formatVttTs(parts[0].trim());
      continue;
    }
    const text = stripped.replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").trim();
    if (text && currentTimestamp) { result.push(`[${currentTimestamp}] ${text}`); currentTimestamp = ''; }
    else if (text) result.push(text);
  }
  return result.join('\n');
}

function parseXml(content) {
  const lines = [];
  const regex = /<text\s+start="([^"]*)"[^>]*>([\s\S]*?)<\/text>/g;
  let match;
  while ((match = regex.exec(content)) !== null) {
    const startSec = parseFloat(match[1]) || 0;
    const text = match[2].replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").trim();
    if (!text) continue;
    const mm = Math.floor(startSec / 60);
    const ss = Math.floor(startSec % 60);
    lines.push(`[${String(mm).padStart(2, '0')}:${String(ss).padStart(2, '0')}] ${text}`);
  }
  return lines.join('\n');
}

function formatVttTs(ts) {
  const parts = ts.split(':');
  if (parts.length >= 3) {
    const hours = parseInt(parts[0]) || 0;
    const minutes = parseInt(parts[1]) || 0;
    const totalMin = hours * 60 + minutes;
    const seconds = (parts[2] || '00').split('.')[0];
    return `${String(totalMin).padStart(2, '0')}:${seconds}`;
  } else if (parts.length === 2) {
    return `${String(parseInt(parts[0])).padStart(2, '0')}:${(parts[1] || '00').split('.')[0]}`;
  }
  return ts;
}

app.get('/health', (req, res) => {
  if (healthState.isRecovering) {
    return res.status(503).json({ ok: false, engine: 'camoufox', recovering: true });
  }
  const running = browser !== null && (browser.isConnected?.() ?? false);
  res.json({ 
    ok: true, 
    engine: 'camoufox',
    browserConnected: running,
    browserRunning: running,
    activeTabs: getTotalTabCount(),
    consecutiveFailures: healthState.consecutiveNavFailures,
  });
});

// Create new tab
app.post('/tabs', async (req, res) => {
  try {
    const { userId, sessionKey, listItemId, url } = req.body;
    // Accept both sessionKey (preferred) and listItemId (legacy) for backward compatibility
    const resolvedSessionKey = sessionKey || listItemId;
    if (!userId || !resolvedSessionKey) {
      return res.status(400).json({ error: 'userId and sessionKey required' });
    }
    
    const session = await getSession(userId);
    
    let totalTabs = 0;
    for (const group of session.tabGroups.values()) totalTabs += group.size;
    if (totalTabs >= MAX_TABS_PER_SESSION) {
      return res.status(429).json({ error: 'Maximum tabs per session reached' });
    }
    
    const group = getTabGroup(session, resolvedSessionKey);
    
    const page = await session.context.newPage();
    const tabId = crypto.randomUUID();
    const tabState = createTabState(page);
    group.set(tabId, tabState);
    
    if (url) {
      const urlErr = validateUrl(url);
      if (urlErr) return res.status(400).json({ error: urlErr });
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
      tabState.visitedUrls.add(url);
    }
    
    log('info', 'tab created', { reqId: req.reqId, tabId, userId, sessionKey: resolvedSessionKey, url: page.url() });
    res.json({ tabId, url: page.url() });
  } catch (err) {
    log('error', 'tab create failed', { reqId: req.reqId, error: err.message });
    res.status(500).json({ error: safeError(err) });
  }
});

// Navigate
app.post('/tabs/:tabId/navigate', async (req, res) => {
  const tabId = req.params.tabId;
  
  try {
    const { userId, url, macro, query, sessionKey, listItemId } = req.body;
    if (!userId) return res.status(400).json({ error: 'userId required' });

    const result = await withUserLimit(userId, () => withTimeout((async () => {
      await ensureBrowser();
      let session = sessions.get(normalizeUserId(userId));
      let found = session && findTab(session, tabId);
      
      let tabState;
      if (!found) {
        const resolvedSessionKey = sessionKey || listItemId || 'default';
        session = await getSession(userId);
        let sessionTabs = 0;
        for (const g of session.tabGroups.values()) sessionTabs += g.size;
        if (getTotalTabCount() >= MAX_TABS_GLOBAL || sessionTabs >= MAX_TABS_PER_SESSION) {
          // Reuse oldest tab in session instead of rejecting
          let oldestTab = null;
          let oldestGroup = null;
          let oldestTabId = null;
          for (const [gKey, group] of session.tabGroups) {
            for (const [tid, ts] of group) {
              if (!oldestTab || ts.toolCalls < oldestTab.toolCalls) {
                oldestTab = ts;
                oldestGroup = group;
                oldestTabId = tid;
              }
            }
          }
          if (oldestTab) {
            tabState = oldestTab;
            const group = getTabGroup(session, resolvedSessionKey);
            if (oldestGroup) oldestGroup.delete(oldestTabId);
            group.set(tabId, tabState);
            tabLocks.delete(oldestTabId);
            log('info', 'tab recycled (limit reached)', { reqId: req.reqId, tabId, recycledFrom: oldestTabId, userId });
          } else {
            throw new Error('Maximum tabs per session reached');
          }
        } else {
          const page = await session.context.newPage();
          tabState = createTabState(page);
          const group = getTabGroup(session, resolvedSessionKey);
          group.set(tabId, tabState);
          log('info', 'tab auto-created on navigate', { reqId: req.reqId, tabId, userId });
        }
      } else {
        tabState = found.tabState;
      }
      tabState.toolCalls++;
      
      let targetUrl = url;
      if (macro) {
        targetUrl = expandMacro(macro, query) || url;
      }
      
      if (!targetUrl) throw new Error('url or macro required');
      
      const urlErr = validateUrl(targetUrl);
      if (urlErr) throw new Error(urlErr);
      
      return await withTabLock(tabId, async () => {
        await tabState.page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
        tabState.visitedUrls.add(targetUrl);
        tabState.lastSnapshot = null;
        tabState.refs = await buildRefs(tabState.page);
        return { ok: true, tabId, url: tabState.page.url(), refsAvailable: tabState.refs.size > 0 };
      });
    })(), HANDLER_TIMEOUT_MS, 'navigate'));
    
    log('info', 'navigated', { reqId: req.reqId, tabId, url: result.url });
    res.json(result);
  } catch (err) {
    log('error', 'navigate failed', { reqId: req.reqId, tabId, error: err.message });
    const status = err.message && err.message.startsWith('Blocked URL scheme') ? 400 : 500;
    res.status(status).json({ error: safeError(err) });
  }
});

// Snapshot
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
    tabState.toolCalls++;

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
      tabState.refs = await buildRefs(tabState.page);
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
    })(), HANDLER_TIMEOUT_MS, 'snapshot'));

    log('info', 'snapshot', { reqId: req.reqId, tabId: req.params.tabId, url: result.url, snapshotLen: result.snapshot?.length, refsCount: result.refsCount, hasScreenshot: !!result.screenshot, truncated: result.truncated });
    res.json(result);
  } catch (err) {
    log('error', 'snapshot failed', { reqId: req.reqId, tabId: req.params.tabId, error: err.message });
    res.status(500).json({ error: safeError(err) });
  }
});

// Wait for page ready
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
    res.status(500).json({ error: safeError(err) });
  }
});

// Click
app.post('/tabs/:tabId/click', async (req, res) => {
  const tabId = req.params.tabId;
  
  try {
    const { userId, ref, selector } = req.body;
    if (!userId) return res.status(400).json({ error: 'userId required' });
    const session = sessions.get(normalizeUserId(userId));
    const found = session && findTab(session, tabId);
    if (!found) return res.status(404).json({ error: 'Tab not found' });
    
    const { tabState } = found;
    tabState.toolCalls++;
    
    if (!ref && !selector) {
      return res.status(400).json({ error: 'ref or selector required' });
    }
    
    const result = await withUserLimit(userId, () => withTimeout(withTabLock(tabId, async () => {
      // Full mouse event sequence for stubborn JS click handlers (mirrors Swift WebView.swift)
      // Dispatches: mouseover → mouseenter → mousedown → mouseup → click
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
      
      const doClick = async (locatorOrSelector, isLocator) => {
        const locator = isLocator ? locatorOrSelector : tabState.page.locator(locatorOrSelector);
        
        try {
          // First try normal click (respects visibility, enabled, not-obscured)
          await locator.click({ timeout: 5000 });
        } catch (err) {
          // Fallback 1: If intercepted by overlay, retry with force
          if (err.message.includes('intercepts pointer events')) {
            log('warn', 'click intercepted, retrying with force');
            try {
              await locator.click({ timeout: 5000, force: true });
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
        if (!locator && tabState.refs.size === 0) {
          // Auto-refresh refs on stale state before failing
          log('info', 'auto-refreshing stale refs before click', { ref });
          tabState.refs = await buildRefs(tabState.page);
          locator = refToLocator(tabState.page, ref, tabState.refs);
        }
        if (!locator) {
          const maxRef = tabState.refs.size > 0 ? `e${tabState.refs.size}` : 'none';
          throw new Error(`Unknown ref: ${ref} (valid refs: e1-${maxRef}, ${tabState.refs.size} total). Refs reset after navigation - call snapshot first.`);
        }
        await doClick(locator, true);
      } else {
        await doClick(selector, false);
      }
      
      await tabState.page.waitForTimeout(500);
      tabState.lastSnapshot = null;
      tabState.refs = await buildRefs(tabState.page);
      
      const newUrl = tabState.page.url();
      tabState.visitedUrls.add(newUrl);
      return { ok: true, url: newUrl, refsAvailable: tabState.refs.size > 0 };
    }), HANDLER_TIMEOUT_MS, 'click'));
    
    log('info', 'clicked', { reqId: req.reqId, tabId, url: result.url });
    res.json(result);
  } catch (err) {
    log('error', 'click failed', { reqId: req.reqId, tabId, error: err.message });
    res.status(500).json({ error: safeError(err) });
  }
});

// Type
app.post('/tabs/:tabId/type', async (req, res) => {
  const tabId = req.params.tabId;
  
  try {
    const { userId, ref, selector, text } = req.body;
    const session = sessions.get(normalizeUserId(userId));
    const found = session && findTab(session, tabId);
    if (!found) return res.status(404).json({ error: 'Tab not found' });
    
    const { tabState } = found;
    tabState.toolCalls++;
    
    if (!ref && !selector) {
      return res.status(400).json({ error: 'ref or selector required' });
    }
    
    await withTabLock(tabId, async () => {
      if (ref) {
        const locator = refToLocator(tabState.page, ref, tabState.refs);
        if (!locator) throw new Error(`Unknown ref: ${ref}`);
        await locator.fill(text, { timeout: 10000 });
      } else {
        await tabState.page.fill(selector, text, { timeout: 10000 });
      }
    });
    
    res.json({ ok: true });
  } catch (err) {
    log('error', 'type failed', { reqId: req.reqId, error: err.message });
    res.status(500).json({ error: safeError(err) });
  }
});

// Press key
app.post('/tabs/:tabId/press', async (req, res) => {
  const tabId = req.params.tabId;
  
  try {
    const { userId, key } = req.body;
    const session = sessions.get(normalizeUserId(userId));
    const found = session && findTab(session, tabId);
    if (!found) return res.status(404).json({ error: 'Tab not found' });
    
    const { tabState } = found;
    tabState.toolCalls++;
    
    await withTabLock(tabId, async () => {
      await tabState.page.keyboard.press(key);
    });
    
    res.json({ ok: true });
  } catch (err) {
    log('error', 'press failed', { reqId: req.reqId, error: err.message });
    res.status(500).json({ error: safeError(err) });
  }
});

// Scroll
app.post('/tabs/:tabId/scroll', async (req, res) => {
  try {
    const { userId, direction = 'down', amount = 500 } = req.body;
    const session = sessions.get(normalizeUserId(userId));
    const found = session && findTab(session, req.params.tabId);
    if (!found) return res.status(404).json({ error: 'Tab not found' });
    
    const { tabState } = found;
    tabState.toolCalls++;
    
    const delta = direction === 'up' ? -amount : amount;
    await tabState.page.mouse.wheel(0, delta);
    await tabState.page.waitForTimeout(300);
    
    res.json({ ok: true });
  } catch (err) {
    log('error', 'scroll failed', { reqId: req.reqId, error: err.message });
    res.status(500).json({ error: safeError(err) });
  }
});

// Back
app.post('/tabs/:tabId/back', async (req, res) => {
  const tabId = req.params.tabId;
  
  try {
    const { userId } = req.body;
    const session = sessions.get(normalizeUserId(userId));
    const found = session && findTab(session, tabId);
    if (!found) return res.status(404).json({ error: 'Tab not found' });
    
    const { tabState } = found;
    tabState.toolCalls++;
    
    const result = await withTimeout(withTabLock(tabId, async () => {
      await tabState.page.goBack({ timeout: 10000 });
      tabState.refs = await buildRefs(tabState.page);
      return { ok: true, url: tabState.page.url() };
    }), HANDLER_TIMEOUT_MS, 'back');
    
    res.json(result);
  } catch (err) {
    log('error', 'back failed', { reqId: req.reqId, error: err.message });
    res.status(500).json({ error: safeError(err) });
  }
});

// Forward
app.post('/tabs/:tabId/forward', async (req, res) => {
  const tabId = req.params.tabId;
  
  try {
    const { userId } = req.body;
    const session = sessions.get(normalizeUserId(userId));
    const found = session && findTab(session, tabId);
    if (!found) return res.status(404).json({ error: 'Tab not found' });
    
    const { tabState } = found;
    tabState.toolCalls++;
    
    const result = await withTimeout(withTabLock(tabId, async () => {
      await tabState.page.goForward({ timeout: 10000 });
      tabState.refs = await buildRefs(tabState.page);
      return { ok: true, url: tabState.page.url() };
    }), HANDLER_TIMEOUT_MS, 'forward');
    
    res.json(result);
  } catch (err) {
    log('error', 'forward failed', { reqId: req.reqId, error: err.message });
    res.status(500).json({ error: safeError(err) });
  }
});

// Refresh
app.post('/tabs/:tabId/refresh', async (req, res) => {
  const tabId = req.params.tabId;
  
  try {
    const { userId } = req.body;
    const session = sessions.get(normalizeUserId(userId));
    const found = session && findTab(session, tabId);
    if (!found) return res.status(404).json({ error: 'Tab not found' });
    
    const { tabState } = found;
    tabState.toolCalls++;
    
    const result = await withTimeout(withTabLock(tabId, async () => {
      await tabState.page.reload({ timeout: 30000 });
      tabState.refs = await buildRefs(tabState.page);
      return { ok: true, url: tabState.page.url() };
    }), HANDLER_TIMEOUT_MS, 'refresh');
    
    res.json(result);
  } catch (err) {
    log('error', 'refresh failed', { reqId: req.reqId, error: err.message });
    res.status(500).json({ error: safeError(err) });
  }
});

// Get links
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
    tabState.toolCalls++;
    
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
    res.status(500).json({ error: safeError(err) });
  }
});

// Screenshot
app.get('/tabs/:tabId/screenshot', async (req, res) => {
  try {
    const userId = req.query.userId;
    const fullPage = req.query.fullPage === 'true';
    const session = sessions.get(normalizeUserId(userId));
    const found = session && findTab(session, req.params.tabId);
    if (!found) return res.status(404).json({ error: 'Tab not found' });
    
    const { tabState } = found;
    const buffer = await tabState.page.screenshot({ type: 'png', fullPage });
    res.set('Content-Type', 'image/png');
    res.send(buffer);
  } catch (err) {
    log('error', 'screenshot failed', { reqId: req.reqId, error: err.message });
    res.status(500).json({ error: safeError(err) });
  }
});

// Stats
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
      toolCalls: tabState.toolCalls,
      refsCount: tabState.refs.size
    });
  } catch (err) {
    log('error', 'stats failed', { reqId: req.reqId, error: err.message });
    res.status(500).json({ error: safeError(err) });
  }
});

// Close tab
app.delete('/tabs/:tabId', async (req, res) => {
  try {
    const { userId } = req.body;
    const session = sessions.get(normalizeUserId(userId));
    const found = session && findTab(session, req.params.tabId);
    if (found) {
      await safePageClose(found.tabState.page);
      found.group.delete(req.params.tabId);
      tabLocks.delete(req.params.tabId);
      if (found.group.size === 0) {
        session.tabGroups.delete(found.listItemId);
      }
      log('info', 'tab closed', { reqId: req.reqId, tabId: req.params.tabId, userId });
    }
    res.json({ ok: true });
  } catch (err) {
    log('error', 'tab close failed', { reqId: req.reqId, error: err.message });
    res.status(500).json({ error: safeError(err) });
  }
});

// Close tab group
app.delete('/tabs/group/:listItemId', async (req, res) => {
  try {
    const { userId } = req.body;
    const session = sessions.get(normalizeUserId(userId));
    const group = session?.tabGroups.get(req.params.listItemId);
    if (group) {
      for (const [tabId, tabState] of group) {
        await safePageClose(tabState.page);
        tabLocks.delete(tabId);
      }
      session.tabGroups.delete(req.params.listItemId);
      log('info', 'tab group closed', { reqId: req.reqId, listItemId: req.params.listItemId, userId });
    }
    res.json({ ok: true });
  } catch (err) {
    log('error', 'tab group close failed', { reqId: req.reqId, error: err.message });
    res.status(500).json({ error: safeError(err) });
  }
});

// Close session
app.delete('/sessions/:userId', async (req, res) => {
  try {
    const userId = normalizeUserId(req.params.userId);
    const session = sessions.get(userId);
    if (session) {
      await session.context.close();
      sessions.delete(userId);
      log('info', 'session closed', { userId });
    }
    if (sessions.size === 0) scheduleBrowserIdleShutdown();
    res.json({ ok: true });
  } catch (err) {
    log('error', 'session close failed', { error: err.message });
    res.status(500).json({ error: safeError(err) });
  }
});

// Cleanup stale sessions
setInterval(() => {
  const now = Date.now();
  for (const [userId, session] of sessions) {
    if (now - session.lastAccess > SESSION_TIMEOUT_MS) {
      session.context.close().catch(() => {});
      sessions.delete(userId);
      log('info', 'session expired', { userId });
    }
  }
  // When all sessions gone, start idle timer to kill browser
  if (sessions.size === 0) {
    scheduleBrowserIdleShutdown();
  }
}, 60_000);

// =============================================================================
// OpenClaw-compatible endpoint aliases
// These allow camoufox to be used as a profile backend for OpenClaw's browser tool
// =============================================================================

// GET / - Status (passive — does not launch browser)
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
    res.status(500).json({ error: safeError(err) });
  }
});

// POST /tabs/open - Open tab (alias for POST /tabs, OpenClaw format)
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
    
    let totalTabs = 0;
    for (const g of session.tabGroups.values()) totalTabs += g.size;
    if (totalTabs >= MAX_TABS_PER_SESSION) {
      return res.status(429).json({ error: 'Maximum tabs per session reached' });
    }
    
    const group = getTabGroup(session, listItemId);
    
    const page = await session.context.newPage();
    const tabId = crypto.randomUUID();
    const tabState = createTabState(page);
    group.set(tabId, tabState);
    
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
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
    res.status(500).json({ error: safeError(err) });
  }
});

// POST /start - Start browser (OpenClaw expects this)
app.post('/start', async (req, res) => {
  try {
    await ensureBrowser();
    res.json({ ok: true, profile: 'camoufox' });
  } catch (err) {
    res.status(500).json({ ok: false, error: safeError(err) });
  }
});

// POST /stop - Stop browser (OpenClaw expects this)
app.post('/stop', async (req, res) => {
  try {
    const adminKey = req.headers['x-admin-key'];
    if (!adminKey || !timingSafeCompare(adminKey, CONFIG.adminKey)) {
      return res.status(403).json({ error: 'Forbidden' });
    }
    if (browser) {
      await browser.close().catch(() => {});
      browser = null;
    }
    sessions.clear();
    res.json({ ok: true, stopped: true, profile: 'camoufox' });
  } catch (err) {
    res.status(500).json({ ok: false, error: safeError(err) });
  }
});

// POST /navigate - Navigate (OpenClaw format with targetId in body)
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
    tabState.toolCalls++;
    
    const result = await withTimeout(withTabLock(targetId, async () => {
      await tabState.page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
      tabState.visitedUrls.add(url);
      tabState.refs = await buildRefs(tabState.page);
      return { ok: true, targetId, url: tabState.page.url() };
    }), HANDLER_TIMEOUT_MS, 'openclaw-navigate');
    
    res.json(result);
  } catch (err) {
    log('error', 'openclaw navigate failed', { reqId: req.reqId, error: err.message });
    res.status(500).json({ error: safeError(err) });
  }
});

// GET /snapshot - Snapshot (OpenClaw format with query params)
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
    tabState.toolCalls++;

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
    res.status(500).json({ error: safeError(err) });
  }
});

// POST /act - Combined action endpoint (OpenClaw format)
// Routes to click/type/scroll/press/etc based on 'kind' parameter
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
    tabState.toolCalls++;
    
    const result = await withTimeout(withTabLock(targetId, async () => {
      switch (kind) {
        case 'click': {
          const { ref, selector, doubleClick } = params;
          if (!ref && !selector) {
            throw new Error('ref or selector required');
          }
          
          const doClick = async (locatorOrSelector, isLocator) => {
            const locator = isLocator ? locatorOrSelector : tabState.page.locator(locatorOrSelector);
            const clickOpts = { timeout: 5000 };
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
            const locator = refToLocator(tabState.page, ref, tabState.refs);
            if (!locator) throw new Error(`Unknown ref: ${ref}`);
            await doClick(locator, true);
          } else {
            await doClick(selector, false);
          }
          
          await tabState.page.waitForTimeout(500);
          tabState.refs = await buildRefs(tabState.page);
          return { ok: true, targetId, url: tabState.page.url() };
        }
        
        case 'type': {
          const { ref, selector, text, submit } = params;
          if (!ref && !selector) {
            throw new Error('ref or selector required');
          }
          if (typeof text !== 'string') {
            throw new Error('text is required');
          }
          
          if (ref) {
            const locator = refToLocator(tabState.page, ref, tabState.refs);
            if (!locator) throw new Error(`Unknown ref: ${ref}`);
            await locator.fill(text, { timeout: 10000 });
            if (submit) await tabState.page.keyboard.press('Enter');
          } else {
            await tabState.page.fill(selector, text, { timeout: 10000 });
            if (submit) await tabState.page.keyboard.press('Enter');
          }
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
            const locator = refToLocator(tabState.page, ref, tabState.refs);
            if (!locator) throw new Error(`Unknown ref: ${ref}`);
            await locator.scrollIntoViewIfNeeded({ timeout: 5000 });
          } else {
            const delta = direction === 'up' ? -amount : amount;
            await tabState.page.mouse.wheel(0, delta);
          }
          await tabState.page.waitForTimeout(300);
          return { ok: true, targetId };
        }
        
        case 'hover': {
          const { ref, selector } = params;
          if (!ref && !selector) throw new Error('ref or selector required');
          
          if (ref) {
            const locator = refToLocator(tabState.page, ref, tabState.refs);
            if (!locator) throw new Error(`Unknown ref: ${ref}`);
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
          tabLocks.delete(targetId);
          return { ok: true, targetId };
        }
        
        default:
          throw new Error(`Unsupported action kind: ${kind}`);
      }
    }), HANDLER_TIMEOUT_MS, 'act');
    
    res.json(result);
  } catch (err) {
    log('error', 'act failed', { reqId: req.reqId, kind: req.body?.kind, error: err.message });
    res.status(500).json({ error: safeError(err) });
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

// Active health probe — detect hung browser even when isConnected() lies
setInterval(async () => {
  if (!browser || healthState.isRecovering) return;
  // Skip probe if operations are in flight
  if (healthState.activeOps > 0) {
    log('info', 'health probe skipped, operations active', { activeOps: healthState.activeOps });
    return;
  }
  const timeSinceSuccess = Date.now() - healthState.lastSuccessfulNav;
  if (timeSinceSuccess < 120000) return;
  
  let testContext;
  try {
    testContext = await browser.newContext();
    const page = await testContext.newPage();
    await page.goto('about:blank', { timeout: 5000 });
    await page.close();
    await testContext.close();
    healthState.lastSuccessfulNav = Date.now();
  } catch (err) {
    log('warn', 'health probe failed', { error: err.message, timeSinceSuccessMs: timeSinceSuccess });
    if (testContext) await testContext.close().catch(() => {});
    restartBrowser('health probe failed').catch(() => {});
  }
}, 60_000);

// Crash logging
process.on('uncaughtException', (err) => {
  log('error', 'uncaughtException', { error: err.message, stack: err.stack });
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

  const forceTimeout = setTimeout(() => {
    log('error', 'shutdown timed out, forcing exit');
    process.exit(1);
  }, 10000);
  forceTimeout.unref();

  server.close();

  for (const [userId, session] of sessions) {
    await session.context.close().catch(() => {});
  }
  if (browser) await browser.close().catch(() => {});
  process.exit(0);
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

const PORT = CONFIG.port;
const server = app.listen(PORT, () => {
  log('info', 'server started', { port: PORT, pid: process.pid, nodeVersion: process.version });
  // Browser launches lazily on first request (saves ~550MB when idle)
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    log('error', 'port in use', { port: PORT });
    process.exit(1);
  }
  log('error', 'server error', { error: err.message });
  process.exit(1);
});
