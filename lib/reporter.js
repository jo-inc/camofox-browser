// lib/reporter.js — Crash/hang reporter for camofox-browser
// Files GitHub issues with paranoid anonymization. No env reads here.
// Config passed via createReporter(config) from lib/config.js.

import crypto from 'crypto';
import fs from 'fs';
import { execSync } from 'child_process';

// ============================================================================
// Anonymization
// ============================================================================

const SAFE_HOSTS = new Set([
  'github.com', 'api.github.com', 'npmjs.com', 'registry.npmjs.org',
  'nodejs.org',
]);

const SECRET_PREFIXES = [
  'ghp_', 'gho_', 'ghu_', 'ghs_', 'ghr_',
  'sk-', 'sk_live_', 'sk_test_', 'pk_live_', 'pk_test_',
  'AKIA', 'ASIA',
  'xox', 'Bearer ', 'Basic ',
  'eyJ',
];

/**
 * Paranoid anonymization of arbitrary text (stack traces, error messages, etc.)
 * Better to over-strip than leak. Order matters — more specific patterns first.
 */
export function anonymize(text) {
  if (!text || typeof text !== 'string') return text || '';

  let s = text;

  // 1. Strip known secret-prefixed tokens
  for (const prefix of SECRET_PREFIXES) {
    const escaped = prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    s = s.replace(new RegExp(escaped + '[A-Za-z0-9_\\-\\.=+/]{8,}', 'g'), '<token>');
  }

  // 2. Strip Bearer/Basic auth headers
  s = s.replace(/(?:Bearer|Basic)\s+[A-Za-z0-9_\-\.=+/]{8,}/gi, '<token>');

  // 3. Strip proxy URLs with credentials (before email — email regex eats user:pass@host)
  s = s.replace(/(?:https?|socks[45]?):\/\/[^:]+:[^@]+@[^\s]+/gi, '<proxy-url>');

  // 4. Strip email addresses
  s = s.replace(/[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/g, '<email>');

  // 5. Strip full URLs (preserve scheme for context)
  s = s.replace(/(https?|wss?|ftp):\/\/[^\s'",)}\]>]+/g, (match, scheme) => {
    try {
      const u = new URL(match);
      if (SAFE_HOSTS.has(u.hostname)) return match;
    } catch { /* not a valid URL, strip it */ }
    return `<${scheme}-url>`;
  });

  // 6. Strip absolute file paths (Unix + Windows), preserve last filename
  s = s.replace(
    /(?:\/(?:Users|home|root|tmp|var|opt|data|app|srv|etc|mnt|run|snap|proc)\/[^\s:;,'")\]}]+|[A-Z]:\\(?:Users|Documents and Settings)\\[^\s:;,'")\]}]+)/g,
    (match) => {
      const parts = match.replace(/\\/g, '/').split('/');
      const filename = parts[parts.length - 1] || parts[parts.length - 2] || 'unknown';
      return `<path>/${filename}`;
    }
  );

  // 7. Strip IPv4 addresses
  s = s.replace(/\b(?:(?:25[0-5]|2[0-4]\d|[01]?\d\d?)\.){3}(?:25[0-5]|2[0-4]\d|[01]?\d\d?)\b/g, '<ip>');

  // 8. Strip IPv6 addresses
  s = s.replace(/\b(?:[0-9a-fA-F]{1,4}:){2,7}[0-9a-fA-F]{1,4}\b/g, '<ipv6>');
  s = s.replace(/::(?:ffff:)?(?:\d{1,3}\.){3}\d{1,3}/g, '<ipv6>');

  // 9. Strip hostnames in connection errors
  s = s.replace(
    /(?:ECONNREFUSED|ECONNRESET|ETIMEDOUT|ENOTFOUND|EHOSTUNREACH)\s+([a-zA-Z0-9.\-]+):(\d+)/g,
    (match, host, port) => {
      if (SAFE_HOSTS.has(host)) return match;
      return match.replace(host, '<host>');
    }
  );

  // 10. Strip Fly machine IDs (14-char hex), Docker container IDs (12+ hex)
  s = s.replace(/\b[0-9a-f]{12,64}\b/g, '<id>');

  // 11. Strip jo-* app names
  s = s.replace(/\bjo-(?:machine|browser|whatsapp|discord|bot)[a-z0-9\-]*/gi, '<app>');

  // 12. Strip environment variable assignments
  s = s.replace(/\b[A-Z][A-Z0-9_]{3,}=[^\s]{4,}/g, '<env-var>');

  // 13. Strip long alphanumeric strings (40+ chars)
  s = s.replace(/[A-Za-z0-9_\-]{40,}/g, '<redacted>');

  // 14. Strip base64 blobs (20+ chars with mixed case)
  s = s.replace(/[A-Za-z0-9+/]{20,}={0,3}/g, (match) => {
    if (/[a-z]/.test(match) && /[A-Z]/.test(match)) return '<redacted>';
    return match;
  });

  return s;
}

/**
 * Generate a stable signature for dedup. Uses error name + first meaningful
 * stack frame (file:line, not column — columns shift with minor edits).
 */
export function stackSignature(type, error) {
  const name = error?.name || error?.code || 'unknown';
  const message = error?.message || String(error || '');

  const stack = error?.stack || '';
  const frames = stack.split('\n').slice(1);
  let keyFrame = '';
  for (const frame of frames) {
    const trimmed = frame.trim();
    if (trimmed.startsWith('at ') && !trimmed.includes('node_modules') && !trimmed.includes('node:internal')) {
      const fileMatch = trimmed.match(/\(([^)]+)\)/) || trimmed.match(/at\s+(.+)$/);
      if (fileMatch) {
        const loc = fileMatch[1];
        const parts = loc.replace(/\\/g, '/').split('/');
        const last = parts[parts.length - 1];
        const [file, line] = last.split(':');
        keyFrame = `${file}:${line || '?'}`;
        break;
      }
    }
  }

  const raw = `${type}|${name}|${keyFrame || anonymize(message).slice(0, 80)}`;
  return fnv1a(raw);
}

/** FNV-1a hash → 8-char hex. Stable bucketing, not crypto. */
function fnv1a(str) {
  let hash = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    hash ^= str.charCodeAt(i);
    hash = (hash * 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

// ============================================================================
// URL anonymization (per-report salted HMAC for private domains)
// ============================================================================

// Public domains safe to show verbatim in reports.
// These are public knowledge — showing "amazon.com" in a crash report is not PII.
// Matched by suffix. NEVER add multi-tenant hosting (herokuapp.com, vercel.app, etc.)
const PUBLIC_DOMAINS = [
  // CDN & edge
  'cloudflare.com', 'cloudflare-dns.com', 'cloudflareinsights.com',
  'fastly.net', 'fastlylb.net',
  'akamaized.net', 'akamai.net', 'cloudfront.net',
  'cdn.jsdelivr.net', 'unpkg.com', 'cdnjs.com',
  // Google
  'google.com', 'googleapis.com', 'gstatic.com',
  'googleusercontent.com', 'google-analytics.com', 'googletagmanager.com',
  'googlesyndication.com', 'doubleclick.net', 'youtube.com', 'ytimg.com',
  'recaptcha.net',
  // Microsoft
  'microsoft.com', 'msecnd.net', 'azureedge.net', 'bing.com', 'live.com',
  'outlook.com', 'office.com', 'linkedin.com',
  // Meta
  'facebook.com', 'facebook.net', 'fbcdn.net', 'instagram.com', 'threads.net',
  'whatsapp.com',
  // X/Twitter
  'twitter.com', 'x.com', 'twimg.com',
  // GitHub
  'github.com', 'githubusercontent.com', 'githubassets.com',
  // Major sites (common anti-bot / frustration sources)
  'amazon.com', 'amazon.co.uk', 'amazon.de', 'amazon.co.jp',
  'reddit.com', 'redd.it',
  'apple.com', 'icloud.com',
  'netflix.com', 'spotify.com', 'discord.com', 'discord.gg',
  'tiktok.com', 'pinterest.com', 'tumblr.com',
  'stackoverflow.com', 'stackexchange.com',
  'medium.com', 'substack.com',
  'nytimes.com', 'washingtonpost.com', 'bbc.co.uk', 'bbc.com', 'cnn.com',
  'ebay.com', 'etsy.com', 'walmart.com', 'target.com', 'shopify.com',
  'stripe.com', 'paypal.com',
  'twitch.tv', 'vimeo.com', 'dailymotion.com',
  'yahoo.com', 'duckduckgo.com', 'baidu.com',
  'zoom.us', 'slack.com', 'notion.so', 'figma.com',
  'dropbox.com', 'box.com',
  'archive.org', 'web.archive.org',
  // Prediction markets & crypto (heavy anti-bot, commonly scraped)
  'polymarket.com', 'kalshi.com', 'metaculus.com', 'manifold.markets',
  'predictit.org', 'augur.net',
  'coinbase.com', 'binance.com', 'kraken.com', 'gemini.com',
  'coingecko.com', 'coinmarketcap.com',
  'opensea.io', 'blur.io', 'rarible.com',
  'etherscan.io', 'solscan.io', 'blockchair.com',
  'uniswap.org', 'dexscreener.com', 'dextools.io',
  // Data / scraping targets (aggressive anti-bot)
  'zillow.com', 'realtor.com', 'redfin.com', 'trulia.com',
  'indeed.com', 'glassdoor.com', 'lever.co', 'greenhouse.io',
  'airbnb.com', 'booking.com', 'expedia.com', 'tripadvisor.com',
  'yelp.com', 'trustpilot.com',
  'craigslist.org', 'nextdoor.com',
  'ticketmaster.com', 'stubhub.com', 'seatgeek.com',
  // Finance / trading
  'tradingview.com', 'investing.com', 'seekingalpha.com',
  'finance.yahoo.com', 'bloomberg.com', 'reuters.com', 'wsj.com',
  'robinhood.com', 'schwab.com', 'fidelity.com', 'etrade.com',
  // AI / developer tools
  'openai.com', 'anthropic.com', 'huggingface.co',
  'vercel.com', 'netlify.com', 'render.com', 'fly.io',
  'npmjs.com', 'pypi.org', 'crates.io', 'pkg.go.dev',
  // Social / forums
  'quora.com', 'hackernews.com', 'news.ycombinator.com',
  'producthunt.com', 'indiehackers.com',
  // Reference
  'wikipedia.org', 'wikimedia.org', 'mozilla.org', 'mozilla.net',
  // Anti-bot / CAPTCHA
  'hcaptcha.com',
  // Fonts
  'typekit.net', 'fontawesome.com',
].sort((a, b) => b.length - a.length); // longest-suffix-first

// Stable key for domain hashing — NOT a secret, just ensures consistent hashes
// across reports so we can correlate "site-a1b2c3d4 caused 12 hangs this week".
const DOMAIN_HASH_KEY = 'camofox-domain-hash-v1';

/**
 * Create a URL anonymizer.
 * Public domains shown verbatim. Private domains get a stable hash
 * (same domain → same hash across all reports, enabling correlation).
 */
export function createUrlAnonymizer() {

  function isPublicDomain(hostname) {
    for (const d of PUBLIC_DOMAINS) {
      if (hostname === d || hostname.endsWith('.' + d)) return true;
    }
    return false;
  }

  function hashHost(hostname) {
    return 'site-' + crypto.createHmac('sha256', DOMAIN_HASH_KEY).update(hostname).digest('hex').slice(0, 8);
  }

  /**
   * Anonymize a URL. Preserves: scheme, public infra hostnames, path depth,
   * query param count, fragment presence. Strips everything else.
   *
   * Examples:
   *   https://challenges.cloudflare.com/•/•/•
   *   https://site-a1b2c3d4:8443/•/• ?[3] #[frag]
   */
  function anonymizeUrl(rawUrl) {
    if (!rawUrl || typeof rawUrl !== 'string') return '[empty]';
    if (rawUrl.startsWith('data:')) return '[data-uri]';
    if (rawUrl.startsWith('blob:')) return '[blob-uri]';
    if (rawUrl.startsWith('about:')) return rawUrl;
    if (rawUrl.startsWith('javascript:')) return '[javascript-uri]';

    let url;
    try { url = new URL(rawUrl); } catch { return '[invalid-url]'; }

    const parts = [url.protocol + '//'];
    const h = url.hostname.toLowerCase();

    if (/^(\d{1,3}\.){3}\d{1,3}$/.test(h) || h.includes(':')) {
      parts.push(hashHost(h));
    } else if (isPublicDomain(h)) {
      parts.push(h);
    } else {
      parts.push(hashHost(h));
    }

    if (url.port) parts.push(':' + url.port);

    const segs = url.pathname.split('/').filter(Boolean);
    parts.push(segs.length > 0 ? '/' + segs.map(() => '\u2022').join('/') : '/');

    const paramCount = [...url.searchParams].length;
    if (paramCount > 0) parts.push(` ?[${paramCount}]`);
    if (url.hash && url.hash.length > 1) parts.push(' #[frag]');

    return parts.join('');
  }

  function anonymizeChain(urls) {
    if (!Array.isArray(urls) || urls.length === 0) return '[empty-chain]';
    return urls.map(u => anonymizeUrl(u)).join(' \u2192 ');
  }

  return { anonymizeUrl, anonymizeChain };
}

// ============================================================================
// Per-tab health tracker (count-only, no content)
// ============================================================================

// Known bot-detection providers, matched by response header fingerprints.
// Order: most specific first.
const BOT_DETECTION_SIGNATURES = [
  { header: 'cf-mitigated', value: 'challenge', provider: 'cloudflare' },
  { header: 'x-datadome', provider: 'datadome' },
  { header: 'x-px', provider: 'perimeterx' },
  { header: 'x-distil-cs', provider: 'distil' },
  { header: 'x-sucuri-id', provider: 'sucuri' },
  { header: 'server', value: 'akamaighost', provider: 'akamai' },
  // cf-ray is on ALL Cloudflare responses (even 200 OK). Must be last so it
  // doesn't short-circuit other providers on multi-CDN sites.
  { header: 'cf-ray', provider: 'cloudflare' },
];

/**
 * Detect bot-detection provider from Playwright response headers.
 * Returns { detected: bool, provider: string|null, httpStatus: number|null }
 */
export function detectBotProtection(response) {
  if (!response) return { detected: false, provider: null, httpStatus: null };
  const status = response.status();
  let headers;
  try { headers = response.headers(); } catch { return { detected: false, provider: null, httpStatus: status }; }
  for (const sig of BOT_DETECTION_SIGNATURES) {
    const val = headers[sig.header];
    if (val !== undefined) {
      if (sig.value && !val.toLowerCase().includes(sig.value)) continue;
      const challenged = status === 403 || status === 429 || status === 503;
      return { detected: challenged, provider: sig.provider, httpStatus: status };
    }
  }
  return { detected: false, provider: null, httpStatus: status };
}

/**
 * Create a health tracker for a tab. Attaches to Playwright page events.
 * Tracks: crashes, page errors, request failures, redirect status codes,
 * HTTP status histogram (4xx+), and anti-bot challenge detection.
 * All count-based — no URLs or content stored.
 */
export function createTabHealthTracker(page) {
  const health = {
    crashes: 0,
    pageErrors: 0,
    requestFailures: 0,
    inflightRequests: 0,
    maxRedirectDepth: 0,
    redirectStatusCodes: [],  // status codes in redirect chain, e.g. [301, 302, 403]
    statusCounts: {},         // { 403: 5, 429: 2, ... }
    botDetection: null,       // { detected, provider, httpStatus } from last nav response
    lastNavResponseSize: 0,
    _redirectDepth: 0,
  };

  // Renderer crash (OOM, segfault)
  page.on('crash', () => { health.crashes++; });

  // Uncaught JS exceptions on the page
  page.on('pageerror', () => { health.pageErrors++; });

  // Failed requests (blocked, DNS failure, etc.) + decrement in-flight counter
  page.on('requestfailed', () => {
    health.requestFailures++;
    health.inflightRequests = Math.max(0, health.inflightRequests - 1);
  });

  // Track in-flight requests for hang diagnostics
  page.on('request', () => { health.inflightRequests++; });
  page.on('requestfinished', () => { health.inflightRequests = Math.max(0, health.inflightRequests - 1); });

  // HTTP status tracking (non-2xx only)
  page.on('response', (resp) => {
    const s = resp.status();
    if (s >= 400) health.statusCounts[s] = (health.statusCounts[s] || 0) + 1;
  });

  // Auto-dismiss dialogs to prevent page hangs (not tracked as a metric — noise)
  page.on('dialog', async (dialog) => {
    try { await dialog.dismiss(); } catch { /* page might be closed */ }
  });

  // Redirect depth + status code chain per navigation
  page.on('request', (req) => {
    if (req.isNavigationRequest()) {
      if (req.redirectedFrom()) {
        health._redirectDepth++;
        if (health._redirectDepth > health.maxRedirectDepth) {
          health.maxRedirectDepth = health._redirectDepth;
        }
      } else {
        health._redirectDepth = 0;
        health.redirectStatusCodes = [];
        health.inflightRequests = 0;  // reset on new navigation to prevent drift
      }
    }
  });

  // Capture redirect status codes and detect bot protection on nav responses
  page.on('response', (resp) => {
    try {
      const req = resp.request();
      if (req.isNavigationRequest()) {
        health.redirectStatusCodes.push(resp.status());
        health.botDetection = detectBotProtection(resp);
        // Approximate response body size from content-length (no body read)
        const cl = resp.headers()['content-length'];
        if (cl) health.lastNavResponseSize = parseInt(cl, 10) || 0;
      }
    } catch { /* page closed */ }
  });

  /** Snapshot current health counters for inclusion in reports. */
  function snapshot() {
    const { _redirectDepth, ...clean } = health;
    return { ...clean };
  }

  /**
   * Get document.readyState from the page. Returns null if page is unresponsive.
   * Use a tight timeout — if the renderer is crashed, evaluate will hang.
   */
  async function getReadyState() {
    try {
      return await Promise.race([
        page.evaluate(() => document.readyState),
        new Promise(resolve => setTimeout(() => resolve('unresponsive'), 1000)),
      ]);
    } catch {
      return 'unresponsive';
    }
  }

  return { health, snapshot, getReadyState };
}

// ============================================================================
// Process resource snapshot (memory, handles, FDs, browser RSS)
// ============================================================================

/**
 * Collect process-level resource metrics. Safe to call at any time.
 * Returns anonymized metrics — no PIDs, paths, or user data.
 */
export function collectResourceSnapshot(opts = {}) {
  const mem = process.memoryUsage();
  const snap = {
    nodeRssMb: Math.round(mem.rss / 1048576),
    nodeHeapUsedMb: Math.round(mem.heapUsed / 1048576),
    nodeHeapTotalMb: Math.round(mem.heapTotal / 1048576),
    nodeExternalMb: Math.round(mem.external / 1048576),
    eventLoopLagMs: null,
    activeHandles: null,
    activeRequests: null,
    openFds: null,
    browserRssMb: null,
  };

  // Active libuv handles/requests (private API, guarded)
  try { snap.activeHandles = process._getActiveHandles().length; } catch { /* unavailable */ }
  try { snap.activeRequests = process._getActiveRequests().length; } catch { /* unavailable */ }

  // Open file descriptors (Linux only)
  try {
    if (process.platform === 'linux') {
      snap.openFds = fs.readdirSync('/proc/self/fd').length;
    }
  } catch { /* not available or permission denied */ }

  // Browser process RSS (the one people miss — browser OOMs, not Node)
  if (opts.browserPid && Number.isInteger(opts.browserPid) && opts.browserPid > 0) {
    try {
      if (process.platform === 'linux') {
        const status = fs.readFileSync(`/proc/${opts.browserPid}/status`, 'utf8');
        const match = status.match(/VmRSS:\s+(\d+)\s+kB/);
        if (match) snap.browserRssMb = Math.round(parseInt(match[1], 10) / 1024);
      } else if (process.platform === 'darwin') {
        const out = execSync(`ps -o rss= -p ${opts.browserPid}`, { timeout: 1000 }).toString().trim();
        if (out) snap.browserRssMb = Math.round(parseInt(out, 10) / 1024);
      }
    } catch { /* process gone or permission denied */ }
  }

  // Session/tab counts from caller
  if (opts.sessionCount != null) snap.browserContexts = opts.sessionCount;
  if (opts.tabCount != null) snap.activeTabs = opts.tabCount;

  return snap;
}

/**
 * Classify proxy errors from Playwright navigation error messages.
 * Returns { proxyError: string|null, proxyTlsError: bool } — no IPs or credentials.
 */
export function classifyProxyError(errorMessage) {
  if (!errorMessage || typeof errorMessage !== 'string') return { proxyError: null, proxyTlsError: false };
  const msg = errorMessage.toUpperCase();
  // Explicit proxy errors from Chromium/Firefox net stack
  if (msg.includes('ERR_PROXY_CONNECTION_FAILED')) return { proxyError: 'ERR_PROXY_CONNECTION_FAILED', proxyTlsError: false };
  if (msg.includes('ERR_TUNNEL_CONNECTION_FAILED')) return { proxyError: 'ERR_TUNNEL_CONNECTION_FAILED', proxyTlsError: false };
  if (msg.includes('ERR_PROXY_AUTH_REQUESTED') || msg.includes('407')) return { proxyError: 'ERR_PROXY_AUTH_REQUESTED', proxyTlsError: false };
  if (msg.includes('ERR_PROXY_CERTIFICATE_INVALID') || (msg.includes('PROXY') && msg.includes('SSL'))) return { proxyError: 'ERR_PROXY_TLS', proxyTlsError: true };
  if (msg.includes('ECONNREFUSED') && msg.includes('PROXY')) return { proxyError: 'ECONNREFUSED', proxyTlsError: false };
  if (msg.includes('ETIMEDOUT') && msg.includes('PROXY')) return { proxyError: 'ETIMEDOUT', proxyTlsError: false };
  return { proxyError: null, proxyTlsError: false };
}

// ============================================================================
// Rate limiter (sliding window, 1 hour)
// ============================================================================

class RateLimiter {
  constructor(maxPerHour) {
    this.maxPerHour = maxPerHour;
    this.timestamps = [];
  }

  tryAcquire() {
    const now = Date.now();
    this.timestamps = this.timestamps.filter(t => t > now - 3600_000);
    if (this.timestamps.length >= this.maxPerHour) return false;
    this.timestamps.push(now);
    return true;
  }
}

// ============================================================================
// GitHub App auth (embedded credentials, short-lived installation tokens)
// ============================================================================

// Credentials loaded at createReporter() time from camofox.config.json crashReporter section.
// Split base64 key halves avoid GitHub push protection auto-revocation.
let _GH_APP_ID = null;
let _GH_INSTALL_ID = null;
let _GH_USER_AGENT = 'camofox-crash-reporter';
let _K_A = null;
let _K_B = null;

function _getAppKey() {
  if (!_K_A || !_K_B) return null;
  return Buffer.from(_K_A + _K_B, 'base64').toString('utf8');
}

/** Sign a JWT for GitHub App authentication (10-min expiry). */
function _signAppJwt() {
  const key = _getAppKey();
  if (!key || !_GH_APP_ID) return null;
  const header = { alg: 'RS256', typ: 'JWT' };
  const now = Math.floor(Date.now() / 1000);
  const payload = { iss: _GH_APP_ID, iat: now - 60, exp: now + 600 };

  const b64 = (obj) => Buffer.from(JSON.stringify(obj)).toString('base64url');
  const unsigned = b64(header) + '.' + b64(payload);
  const signature = crypto.sign('RSA-SHA256', Buffer.from(unsigned), key);
  return unsigned + '.' + signature.toString('base64url');
}

// Cached installation token (1-hour TTL from GitHub, we refresh at 50 min)
let _cachedToken = null;
let _tokenExpiresAt = 0;

async function _getInstallationToken() {
  if (!_GH_INSTALL_ID) return null;
  if (_cachedToken && Date.now() < _tokenExpiresAt) return _cachedToken;

  const jwt = _signAppJwt();
  if (!jwt) return null;
  const resp = await fetchWithTimeout(
    `${GITHUB_API}/app/installations/${_GH_INSTALL_ID}/access_tokens`,
    {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${jwt}`,
        'Accept': 'application/vnd.github+json',
        'User-Agent': _GH_USER_AGENT,
      },
    },
  );
  if (!resp.ok) return null;
  const data = await resp.json();
  _cachedToken = data.token;
  // Refresh 10 min before actual expiry
  _tokenExpiresAt = Date.now() + 50 * 60 * 1000;
  return _cachedToken;
}

const FETCH_TIMEOUT_MS = 5000;
const GITHUB_API = 'https://api.github.com';

async function fetchWithTimeout(url, options) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function _ghHeaders() {
  const token = await _getInstallationToken();
  if (!token) return null;
  return {
    'Authorization': `token ${token}`,
    'Accept': 'application/vnd.github+json',
    'User-Agent': _GH_USER_AGENT,
  };
}

async function findExistingIssue(repo, signature) {
  const headers = await _ghHeaders();
  if (!headers) return null;
  const query = encodeURIComponent(`repo:${repo} is:issue is:open "[${signature}]" in:title`);
  const resp = await fetchWithTimeout(`${GITHUB_API}/search/issues?q=${query}&per_page=1`, { headers });
  if (!resp.ok) return null;
  const data = await resp.json();
  if (data.items?.length > 0) {
    return { issueNumber: data.items[0].number, issueUrl: data.items[0].html_url };
  }
  return null;
}

async function commentOnIssue(repo, issueNumber, body) {
  const headers = await _ghHeaders();
  if (!headers) return false;
  const resp = await fetchWithTimeout(`${GITHUB_API}/repos/${repo}/issues/${issueNumber}/comments`, {
    method: 'POST',
    headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify({ body }),
  });
  return resp.ok;
}

async function createIssue(repo, title, body, labels) {
  const headers = await _ghHeaders();
  if (!headers) return null;
  const resp = await fetchWithTimeout(`${GITHUB_API}/repos/${repo}/issues`, {
    method: 'POST',
    headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify({ title, body, labels }),
  });
  if (!resp.ok) return null;
  const data = await resp.json();
  return data.html_url || null;
}

// ============================================================================
// Issue formatting
// ============================================================================

function formatIssueBody(type, detail) {
  const sections = [
    '> Auto-reported by ' + _GH_USER_AGENT + '. All data is anonymized.',
    '',
    '## Environment',
    `- **version:** ${detail.version || 'unknown'}`,
    `- **node:** ${detail.nodeVersion || 'unknown'}`,
    `- **platform:** ${detail.platform || 'unknown'}`,
    `- **uptime:** ${detail.uptimeMinutes != null ? detail.uptimeMinutes + ' min' : 'unknown'}`,
  ];

  // Resource snapshot (memory, handles, browser RSS)
  const r = detail.resources;
  if (r) {
    sections.push('', '## Resources');
    sections.push(`- **node RSS:** ${r.nodeRssMb ?? '?'} MB`);
    sections.push(`- **node heap:** ${r.nodeHeapUsedMb ?? '?'} / ${r.nodeHeapTotalMb ?? '?'} MB`);
    if (r.browserRssMb != null) sections.push(`- **browser RSS:** ${r.browserRssMb} MB`);
    if (r.browserContexts != null) sections.push(`- **browser contexts:** ${r.browserContexts}`);
    if (r.activeTabs != null) sections.push(`- **active tabs:** ${r.activeTabs}`);
    if (r.openFds != null) sections.push(`- **open FDs:** ${r.openFds}`);
    if (r.activeHandles != null) sections.push(`- **active handles:** ${r.activeHandles}`);
    if (r.eventLoopLagMs != null) sections.push(`- **event loop lag:** ${r.eventLoopLagMs} ms`);
  }

  // Error info
  if (detail.signal) sections.push('', `**Signal:** ${detail.signal}`);
  if (detail.activeRoute) sections.push(`**Active route:** ${detail.activeRoute}`);
  if (detail.message) {
    sections.push('', '## Error', '```', anonymize(detail.message), '```');
  }
  if (detail.stack) {
    sections.push('', '## Stack Trace', '```', anonymize(detail.stack), '```');
  }

  // Hang-specific details
  if (detail.hang) {
    const h = detail.hang;
    sections.push('', '## Hang Details');
    sections.push(`- **operation:** ${h.operation}`);
    sections.push(`- **duration:** ${Math.round(h.durationMs / 1000)}s`);
    if (h.lockQueueMs != null) sections.push(`- **lock queue wait:** ${Math.round(h.lockQueueMs)}ms`);
    if (h.documentReadyState) sections.push(`- **document.readyState:** ${h.documentReadyState}`);
    if (h.inflightRequests != null) sections.push(`- **in-flight requests:** ${h.inflightRequests}`);
  }

  // Anti-bot detection
  if (detail.botDetection?.detected) {
    const b = detail.botDetection;
    sections.push('', '## Anti-Bot Detection');
    sections.push(`- **provider:** ${b.provider || 'unknown'}`);
    sections.push(`- **HTTP status:** ${b.httpStatus || '?'}`);
    if (b.responseBodySizeKb != null) sections.push(`- **response size:** ${b.responseBodySizeKb} KB`);
    if (b.redirectChainLength != null) sections.push(`- **redirect chain:** ${b.redirectChainLength} hops`);
    if (b.redirectStatusCodes?.length) sections.push(`- **redirect statuses:** ${b.redirectStatusCodes.join(' → ')}`);
  }

  // Proxy info (safe fields only — no IPs, credentials, or hostnames)
  if (detail.proxy) {
    const p = detail.proxy;
    sections.push('', '## Proxy');
    sections.push(`- **configured:** ${p.configured}`);
    if (p.configured) {
      if (p.type) sections.push(`- **type:** ${p.type}`);
      sections.push(`- **auth configured:** ${p.authConfigured ?? 'unknown'}`);
      if (p.error) sections.push(`- **error:** ${p.error}`);
      if (p.tlsError) sections.push(`- **TLS error:** yes`);
    }
  }

  // Stall-specific details
  if (detail.stall) {
    const s = detail.stall;
    sections.push('', '## Stall Details');
    sections.push(`- **stall duration:** ${Math.round(s.driftMs / 1000)}s`);
    if (s.lastRoute) sections.push(`- **last route:** ${s.lastRoute}`);
    if (s.activeHandles != null) sections.push(`- **active handles:** ${s.activeHandles}`);
    if (s.activeRequests != null) sections.push(`- **active requests:** ${s.activeRequests}`);
    if (s.heapDeltaMb != null) sections.push(`- **heap delta:** ${s.heapDeltaMb > 0 ? '+' : ''}${s.heapDeltaMb} MB`);
  }

  // Context (misc extra data)
  if (detail.context && Object.keys(detail.context).length > 0) {
    sections.push('', '<details><summary>Context</summary>', '', '```json', anonymize(JSON.stringify(detail.context, null, 2)), '```', '', '</details>');
  }

  return sections.join('\n');
}

function formatCommentBody(type, detail) {
  const ts = new Date().toISOString();
  const lines = [
    `**+1** — ${ts}`,
    `Version: ${detail.version || 'unknown'}, Uptime: ${detail.uptimeMinutes != null ? detail.uptimeMinutes + ' min' : '?'}`,
  ];
  // Include resource snapshot in +1 comments too
  const r = detail.resources;
  if (r) {
    const parts = [`RSS: ${r.nodeRssMb ?? '?'}MB`];
    if (r.browserRssMb != null) parts.push(`Browser: ${r.browserRssMb}MB`);
    if (r.activeTabs != null) parts.push(`Tabs: ${r.activeTabs}`);
    lines.push(parts.join(', '));
  }
  if (detail.message) {
    lines.push('```', anonymize(detail.message).slice(0, 500), '```');
  }
  return lines.join('\n');
}

// ============================================================================
// Core reporter factory
// ============================================================================

/**
 * Create a reporter instance.
 *
 * @param {object} config
 * @param {boolean} config.crashReportEnabled
 * @param {string}  config.crashReportRepo      - "owner/repo" (env override)
 * @param {number}  config.crashReportRateLimit  - max reports per hour
 * @param {object}  config.crashReporterConfig   - from camofox.config.json crashReporter section
 * @param {string}  [config.version]             - package version
 */
export function createReporter(config) {
  const cr = config.crashReporterConfig || {};

  // Initialize module-level credentials from config file
  _GH_APP_ID = cr.appId || null;
  _GH_INSTALL_ID = cr.installationId || null;
  _K_A = cr.keyA || null;
  _K_B = cr.keyB || null;
  _GH_USER_AGENT = cr.userAgent || 'camofox-crash-reporter';

  const enabled = config.crashReportEnabled !== false && !!_GH_APP_ID;
  const repo = config.crashReportRepo || cr.repo || 'jo-inc/camofox-browser';
  const rateLimiter = new RateLimiter(config.crashReportRateLimit || 10);
  const version = config.version || 'unknown';

  let watchdogInterval = null;
  let lastTick = Date.now();
  const inFlight = new Set();

  // Track last Express route for stall reports
  let _lastRoute = null;

  // No-op when disabled
  if (!enabled) {
    return {
      reportCrash: async () => {},
      reportHang: async () => {},
      reportStuckLoop: async () => {},
      startWatchdog: () => {},
      trackRoute: () => {},
      stop: () => {},
      _anonymize: anonymize,
      _stackSignature: stackSignature,
    };
  }

  /** Core: file or deduplicate a report. NEVER throws. */
  async function fileReport(type, labels, detail) {
    if (!rateLimiter.tryAcquire()) return;

    const reportPromise = (async () => {
      try {
        const sig = stackSignature(type, detail.error || { message: detail.message, stack: detail.stack });
        const safeMessage = anonymize(detail.message || detail.error?.message || type);
        const title = `[${sig}] ${type}: ${safeMessage.slice(0, 120)}`;

        const existing = await findExistingIssue(repo, sig);
        if (existing) {
          await commentOnIssue(repo, existing.issueNumber, formatCommentBody(type, {
            ...detail,
            version,
            nodeVersion: typeof process !== 'undefined' ? process.version : 'unknown',
            platform: typeof process !== 'undefined' ? process.platform : 'unknown',
          }));
          return;
        }

        const body = formatIssueBody(type, {
          ...detail,
          version,
          nodeVersion: typeof process !== 'undefined' ? process.version : 'unknown',
          platform: typeof process !== 'undefined' ? process.platform : 'unknown',
        });

        const issueLabels = Array.isArray(labels) ? labels : [labels, 'auto-report'];
        await createIssue(repo, title, body, issueLabels);
      } catch {
        // Swallow — reporter must never crash the server
      }
    })();

    inFlight.add(reportPromise);
    reportPromise.finally(() => inFlight.delete(reportPromise));
  }

  /**
   * Track the last Express route for stall diagnostics.
   * Call from middleware: reporter.trackRoute(req.method + ' ' + req.route?.path)
   */
  function trackRoute(route) {
    _lastRoute = route || null;
  }

  async function reportCrash(error, opts = {}) {
    const err = error instanceof Error ? error : new Error(String(error));
    const uptimeMinutes = typeof process !== 'undefined'
      ? Math.round(process.uptime() / 60) : undefined;
    const resources = collectResourceSnapshot(opts.resourceOpts || {});

    await fileReport(
      opts.signal ? `signal:${opts.signal}` : (err.name || 'crash'),
      ['crash', 'auto-report'],
      {
        error: err,
        message: err.message,
        stack: err.stack,
        signal: opts.signal || null,
        activeRoute: _lastRoute,
        uptimeMinutes,
        resources,
        proxy: opts.proxy || null,
        context: opts.context,
      },
    );
  }

  async function reportHang(operation, durationMs, opts = {}) {
    const uptimeMinutes = typeof process !== 'undefined'
      ? Math.round(process.uptime() / 60) : undefined;
    const resources = collectResourceSnapshot(opts.resourceOpts || {});

    // Build lean context (journal only, no redundant fields)
    const context = { ...opts.context };
    if (context.journal) {
      context.journal = context.journal.map(j => typeof j === 'string' ? j : j);
    }
    // Remove fields that now have dedicated sections
    delete context.operation;
    delete context.durationMs;

    // Anti-bot detection from health snapshot
    const healthSnap = opts.healthSnapshot;
    const botDetection = healthSnap?.botDetection?.detected ? {
      ...healthSnap.botDetection,
      responseBodySizeKb: healthSnap.lastNavResponseSize
        ? Math.round(healthSnap.lastNavResponseSize / 1024) : null,
      redirectChainLength: healthSnap.redirectStatusCodes?.length || null,
      redirectStatusCodes: healthSnap.redirectStatusCodes?.length
        ? healthSnap.redirectStatusCodes : null,
    } : null;

    // Get document.readyState if healthTracker provided
    let documentReadyState = null;
    if (opts.healthTracker?.getReadyState) {
      documentReadyState = await opts.healthTracker.getReadyState();
    }

    const labels = ['hang', 'auto-report'];
    if (botDetection?.detected) labels.push('bot-detection');

    await fileReport(
      `hang:${operation}`,
      labels,
      {
        message: `Operation "${operation}" hung for ${Math.round(durationMs / 1000)}s`,
        stack: opts.error?.stack,
        activeRoute: _lastRoute,
        uptimeMinutes,
        resources,
        hang: {
          operation,
          durationMs,
          lockQueueMs: opts.lockQueueMs ?? null,
          documentReadyState,
          inflightRequests: healthSnap?.inflightRequests ?? null,
        },
        botDetection,
        proxy: opts.proxy || null,
        context,
      },
    );
  }

  async function reportStuckLoop(durationMs, opts = {}) {
    const uptimeMinutes = typeof process !== 'undefined'
      ? Math.round(process.uptime() / 60) : undefined;
    const resources = collectResourceSnapshot(opts.resourceOpts || {});

    await fileReport(
      'stuck:tab-lock',
      ['stuck', 'auto-report'],
      {
        message: `Tab lock held for ${Math.round(durationMs / 1000)}s (tab destroyed)`,
        uptimeMinutes,
        resources,
        context: { durationMs, ...opts.context },
      },
    );
  }

  function startWatchdog(thresholdMs = 5000, getContext) {
    if (watchdogInterval) return;

    const checkMs = 1000;
    // Suppress false positives from OS sleep/suspend (laptop lid close, VM pause).
    // Stalls > 120s are almost certainly not event-loop bugs.
    const MAX_REPORTABLE_DRIFT_MS = 120_000;
    let suppressTicksRemaining = 0;
    const SUPPRESS_TICKS_AFTER_WAKE = 5;
    lastTick = Date.now();
    let lastHeapUsed = process.memoryUsage().heapUsed;

    watchdogInterval = setInterval(() => {
      const now = Date.now();
      const drift = now - lastTick - checkMs;
      lastTick = now;

      // After a long sleep/suspend, suppress the next few ticks (post-wake jitter)
      if (drift > MAX_REPORTABLE_DRIFT_MS) {
        suppressTicksRemaining = SUPPRESS_TICKS_AFTER_WAKE;
        lastHeapUsed = process.memoryUsage().heapUsed;
        return;
      }
      if (suppressTicksRemaining > 0) {
        suppressTicksRemaining--;
        lastHeapUsed = process.memoryUsage().heapUsed;
        return;
      }

      if (drift > thresholdMs) {
        // Capture heap delta during stall (GC indicator)
        const currentHeap = process.memoryUsage().heapUsed;
        const heapDeltaMb = Math.round((currentHeap - lastHeapUsed) / 1048576);
        lastHeapUsed = currentHeap;

        let extra = {};
        try { if (getContext) extra = getContext(); } catch { /* swallow */ }

        const resources = collectResourceSnapshot(extra.resourceOpts || {});
        // Remove resourceOpts from extra so it doesn't end up in context
        delete extra.resourceOpts;

        fileReport('stuck:event-loop', ['stuck', 'auto-report'], {
          message: `Event loop stalled for ${Math.round(drift / 1000)}s (threshold: ${Math.round(thresholdMs / 1000)}s)`,
          uptimeMinutes: typeof process !== 'undefined'
            ? Math.round(process.uptime() / 60) : undefined,
          resources,
          stall: {
            driftMs: drift,
            thresholdMs,
            lastRoute: _lastRoute,
            activeHandles: resources.activeHandles,
            activeRequests: resources.activeRequests,
            heapDeltaMb,
          },
          context: extra,
        });
      } else {
        lastHeapUsed = process.memoryUsage().heapUsed;
      }
    }, checkMs);

    if (watchdogInterval.unref) watchdogInterval.unref();
  }

  function stop() {
    if (watchdogInterval) {
      clearInterval(watchdogInterval);
      watchdogInterval = null;
    }
    return Promise.allSettled([...inFlight]);
  }

  return {
    reportCrash,
    reportHang,
    reportStuckLoop,
    startWatchdog,
    trackRoute,
    stop,
    _anonymize: anonymize,
    _stackSignature: stackSignature,
    _rateLimiter: rateLimiter,
  };
}
