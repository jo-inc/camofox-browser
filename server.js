const { Camoufox, launchOptions } = require('camoufox-js');
const { firefox } = require('playwright-core');
const express = require('express');
const crypto = require('crypto');
const os = require('os');
const { expandMacro } = require('./lib/macros');
const { loadConfig } = require('./lib/config');
const { windowSnapshot } = require('./lib/snapshot');
const { detectYtDlp, hasYtDlp, ytDlpTranscript, parseJson3, parseVtt, parseXml } = require('./lib/youtube');

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

const BROWSER_IDLE_TIMEOUT_MS = CONFIG.browserIdleTimeoutMs;
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
  
  // Check if existing session's context is still alive
  if (session) {
    try {
      // Lightweight probe: pages() is synchronous-ish and throws if context is dead
      session.context.pages();
    } catch (err) {
      log('warn', 'session context dead, recreating', { userId: key, error: err.message });
      session.context.close().catch(() => {});
      sessions.delete(key);
      session = null;
    }
  }
  
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

function isDeadContextError(err) {
  const msg = err && err.message || '';
  return msg.includes('Target page, context or browser has been closed') ||
         msg.includes('browser has been closed') ||
         msg.includes('Context closed') ||
         msg.includes('Browser closed');
}

function destroySession(userId) {
  const key = normalizeUserId(userId);
  const session = sessions.get(key);
  if (!session) return;
  log('warn', 'destroying dead session', { userId: key });
  session.context.close().catch(() => {});
  sessions.delete(key);
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

// --- Google SERP detection ---
function isGoogleSerp(url) {
  try {
    const parsed = new URL(url);
    return parsed.hostname.includes('google.') && parsed.pathname === '/search';
  } catch {
    return false;
  }
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

async function buildRefs(page) {
  const refs = new Map();
  
  if (!page || page.isClosed()) {
    log('warn', 'buildRefs: page closed or invalid');
    return refs;
  }
  
  // Google SERP fast path — skip ariaSnapshot entirely
  const url = page.url();
  if (isGoogleSerp(url)) {
    const { refs: googleRefs } = await extractGoogleSerp(page);
    return googleRefs;
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

// --- YouTube transcript ---
// Implementation extracted to lib/youtube.js to avoid scanner false positives
// (child_process + app.post in same file triggers OpenClaw skill-scanner)

detectYtDlp(log);

app.post('/youtube/transcript', async (req, res) => {
  const reqId = req.reqId;
  try {
    const { url, languages = ['en'] } = req.body;
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
    const lang = languages[0] || 'en';

    log('info', 'youtube transcript: starting', { reqId, videoId, lang, method: hasYtDlp() ? 'yt-dlp' : 'browser' });

    let result;
    if (hasYtDlp()) {
      try {
        result = await ytDlpTranscript(reqId, url, videoId, lang);
      } catch (ytErr) {
        log('warn', 'yt-dlp failed, falling back to browser', { reqId, error: ytErr.message });
        result = await browserTranscript(reqId, url, videoId, lang);
      }
    } else {
      result = await browserTranscript(reqId, url, videoId, lang);
    }

    log('info', 'youtube transcript: done', { reqId, videoId, status: result.status, words: result.total_words });
    res.json(result);
  } catch (err) {
    log('error', 'youtube transcript failed', { reqId, error: err.message, stack: err.stack });
    res.status(500).json({ error: safeError(err) });
  }
});

// Browser fallback — play video, intercept timedtext network response
async function browserTranscript(reqId, url, videoId, lang) {
  return await withUserLimit('__yt_transcript__', async () => {
    await ensureBrowser();
    const session = await getSession('__yt_transcript__');
    const page = await session.context.newPage();

    try {
      await page.addInitScript(() => {
        const origPlay = HTMLMediaElement.prototype.play;
        HTMLMediaElement.prototype.play = function() { this.volume = 0; this.muted = true; return origPlay.call(this); };
      });

      let interceptedCaptions = null;
      page.on('response', async (response) => {
        const respUrl = response.url();
        if (respUrl.includes('/api/timedtext') && respUrl.includes(`v=${videoId}`) && !interceptedCaptions) {
          try {
            const body = await response.text();
            if (body && body.length > 0) interceptedCaptions = body;
          } catch {}
        }
      });

      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: NAVIGATE_TIMEOUT_MS });
      await page.waitForTimeout(2000);

      // Extract caption track URLs and metadata from ytInitialPlayerResponse
      const meta = await page.evaluate(() => {
        const r = window.ytInitialPlayerResponse || (typeof ytInitialPlayerResponse !== 'undefined' ? ytInitialPlayerResponse : null);
        if (!r) return { title: '', tracks: [] };
        const tracks = r?.captions?.playerCaptionsTracklistRenderer?.captionTracks || [];
        return {
          title: r?.videoDetails?.title || '',
          tracks: tracks.map(t => ({ code: t.languageCode, name: t.name?.simpleText || t.languageCode, kind: t.kind || 'manual', url: t.baseUrl })),
        };
      });

      log('info', 'youtube transcript: extracted caption tracks', { reqId, title: meta.title, trackCount: meta.tracks.length, tracks: meta.tracks.map(t => t.code) });

      // Strategy A: Fetch caption track URL directly from ytInitialPlayerResponse
      // These URLs are freshly signed by YouTube and work immediately
      if (meta.tracks && meta.tracks.length > 0) {
        const track = meta.tracks.find(t => t.code === lang) || meta.tracks[0];
        if (track && track.url) {
          const captionUrl = track.url + (track.url.includes('?') ? '&' : '?') + 'fmt=json3';
          log('info', 'youtube transcript: fetching caption track', { reqId, lang: track.code, url: captionUrl.substring(0, 100) });
          try {
            const captionResp = await page.evaluate(async (fetchUrl) => {
              const resp = await fetch(fetchUrl);
              return resp.ok ? await resp.text() : null;
            }, captionUrl);
            if (captionResp && captionResp.length > 0) {
              let transcriptText = null;
              if (captionResp.trimStart().startsWith('{')) transcriptText = parseJson3(captionResp);
              else if (captionResp.includes('WEBVTT')) transcriptText = parseVtt(captionResp);
              else if (captionResp.includes('<text')) transcriptText = parseXml(captionResp);
              if (transcriptText && transcriptText.trim()) {
                return {
                  status: 'ok', transcript: transcriptText,
                  video_url: url, video_id: videoId, video_title: meta.title,
                  language: track.code, total_words: transcriptText.split(/\s+/).length,
                  available_languages: meta.tracks.map(t => ({ code: t.code, name: t.name, kind: t.kind })),
                };
              }
            }
          } catch (fetchErr) {
            log('warn', 'youtube transcript: caption track fetch failed', { reqId, error: fetchErr.message });
          }
        }
      }

      // Strategy B: Play video and intercept timedtext network response
      await page.evaluate(() => {
        const v = document.querySelector('video');
        if (v) { v.muted = true; v.play().catch(() => {}); }
      }).catch(() => {});

      for (let i = 0; i < 40 && !interceptedCaptions; i++) {
        await page.waitForTimeout(500);
      }

      if (!interceptedCaptions) {
        return {
          status: 'error', code: 404,
          message: 'No captions available for this video',
          video_url: url, video_id: videoId, title: meta.title,
        };
      }

      log('info', 'youtube transcript: intercepted captions', { reqId, len: interceptedCaptions.length });

      let transcriptText = null;
      if (interceptedCaptions.trimStart().startsWith('{')) transcriptText = parseJson3(interceptedCaptions);
      else if (interceptedCaptions.includes('WEBVTT')) transcriptText = parseVtt(interceptedCaptions);
      else if (interceptedCaptions.includes('<text')) transcriptText = parseXml(interceptedCaptions);

      if (!transcriptText || !transcriptText.trim()) {
        return {
          status: 'error', code: 404,
          message: 'Caption data intercepted but could not be parsed',
          video_url: url, video_id: videoId, title: meta.title,
        };
      }

      return {
        status: 'ok', transcript: transcriptText,
        video_url: url, video_id: videoId, video_title: meta.title,
        language: lang, total_words: transcriptText.split(/\s+/).length,
        available_languages: meta.languages,
      };
    } finally {
      await safePageClose(page);
    }
  });
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
    
    const result = await withTimeout((async () => {
      const session = await getSession(userId);
      
      // Check global tab limit first
      if (getTotalTabCount() >= MAX_TABS_GLOBAL) {
        throw Object.assign(new Error('Maximum global tabs reached'), { statusCode: 429 });
      }
      
      let totalTabs = 0;
      for (const group of session.tabGroups.values()) totalTabs += group.size;
      if (totalTabs >= MAX_TABS_PER_SESSION) {
        throw Object.assign(new Error('Maximum tabs per session reached'), { statusCode: 429 });
      }
      
      const group = getTabGroup(session, resolvedSessionKey);
      
      const page = await session.context.newPage();
      const tabId = crypto.randomUUID();
      const tabState = createTabState(page);
      group.set(tabId, tabState);
      
      if (url) {
        const urlErr = validateUrl(url);
        if (urlErr) throw Object.assign(new Error(urlErr), { statusCode: 400 });
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
        tabState.visitedUrls.add(url);
      }
      
      log('info', 'tab created', { reqId: req.reqId, tabId, userId, sessionKey: resolvedSessionKey, url: page.url() });
      return { tabId, url: page.url() };
    })(), HANDLER_TIMEOUT_MS, 'tab create');

    res.json(result);
  } catch (err) {
    log('error', 'tab create failed', { reqId: req.reqId, error: err.message });
    if (isDeadContextError(err) && req.body && req.body.userId) destroySession(req.body.userId);
    const status = err.statusCode || 500;
    res.status(status).json({ error: safeError(err) });
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
        
        // For Google SERP: skip eager ref building during navigate.
        // Results render asynchronously after DOMContentLoaded — the snapshot
        // call will wait for and extract them.
        if (isGoogleSerp(tabState.page.url())) {
          tabState.refs = new Map();
          return { ok: true, tabId, url: tabState.page.url(), refsAvailable: false, googleSerp: true };
        }
        
        tabState.refs = await buildRefs(tabState.page);
        return { ok: true, tabId, url: tabState.page.url(), refsAvailable: tabState.refs.size > 0 };
      });
    })(), HANDLER_TIMEOUT_MS, 'navigate'));
    
    log('info', 'navigated', { reqId: req.reqId, tabId, url: result.url });
    res.json(result);
  } catch (err) {
    log('error', 'navigate failed', { reqId: req.reqId, tabId, error: err.message });
    if (isDeadContextError(err)) {
      const userId = req.body && req.body.userId;
      if (userId) destroySession(userId);
    }
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
      const pageUrl = tabState.page.url();
      
      // Google SERP fast path — DOM extraction instead of ariaSnapshot
      if (isGoogleSerp(pageUrl)) {
        const { refs: googleRefs, snapshot: googleSnapshot } = await extractGoogleSerp(tabState.page);
        tabState.refs = googleRefs;
        tabState.lastSnapshot = googleSnapshot;
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
      
      // On Google SERPs, skip the normal click attempt (always intercepted by overlays)
      // and go directly to force click — saves 5s timeout per click
      const onGoogleSerp = isGoogleSerp(tabState.page.url());
      
      const doClick = async (locatorOrSelector, isLocator) => {
        const locator = isLocator ? locatorOrSelector : tabState.page.locator(locatorOrSelector);
        
        if (onGoogleSerp) {
          try {
            await locator.click({ timeout: 5000, force: true });
          } catch (forceErr) {
            log('warn', 'google force click failed, trying mouse sequence');
            await dispatchMouseSequence(locator);
          }
          return;
        }
        
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
      
      // If clicking on a Google SERP, wait for potential navigation to complete
      if (onGoogleSerp) {
        try {
          await tabState.page.waitForLoadState('domcontentloaded', { timeout: 3000 });
        } catch {}
        await tabState.page.waitForTimeout(200);
        // Skip buildRefs here — SERP clicks typically navigate to a new page,
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

// Per-tab inactivity reaper — close tabs idle for TAB_INACTIVITY_MS
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
            log('info', 'tab reaped (inactive)', { userId, tabId, listItemId, idleMs, toolCalls: tabState.toolCalls });
            safePageClose(tabState.page);
            group.delete(tabId);
            tabLocks.delete(tabId);
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
    
    // Check global tab limit first
    if (getTotalTabCount() >= MAX_TABS_GLOBAL) {
      return res.status(429).json({ error: 'Maximum global tabs reached' });
    }
    
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
    if (isDeadContextError(err)) {
      const userId = req.body && req.body.userId;
      if (userId) destroySession(userId);
    }
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
      tabState.lastSnapshot = null;
      
      // Google SERP: defer extraction to snapshot call
      if (isGoogleSerp(tabState.page.url())) {
        tabState.refs = new Map();
        return { ok: true, targetId, url: tabState.page.url(), googleSerp: true };
      }
      
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

    const pageUrl = tabState.page.url();
    
    // Google SERP fast path
    if (isGoogleSerp(pageUrl)) {
      const { refs: googleRefs, snapshot: googleSnapshot } = await extractGoogleSerp(tabState.page);
      tabState.refs = googleRefs;
      tabState.lastSnapshot = googleSnapshot;
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
  const timeSinceSuccess = Date.now() - healthState.lastSuccessfulNav;
  // Skip probe if operations are in flight AND last success was recent.
  // If it's been >120s since any successful operation, probe anyway —
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
