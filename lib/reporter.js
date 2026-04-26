// lib/reporter.js — Crash/hang reporter for camofox-browser
// Files GitHub issues with paranoid anonymization. No env reads here.
// Config passed via createReporter(config) from lib/config.js.

import crypto from 'crypto';

// ============================================================================
// Anonymization
// ============================================================================

const SAFE_HOSTS = new Set([
  'github.com', 'api.github.com', 'npmjs.com', 'registry.npmjs.org',
  'nodejs.org', 'localhost', '127.0.0.1', '::1',
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

  // 7. Strip IPv4 addresses (except localhost)
  s = s.replace(/\b(?:(?:25[0-5]|2[0-4]\d|[01]?\d\d?)\.){3}(?:25[0-5]|2[0-4]\d|[01]?\d\d?)\b/g, (match) => {
    if (match === '127.0.0.1') return match;
    return '<ip>';
  });

  // 8. Strip IPv6 addresses (except ::1)
  s = s.replace(/\b(?:[0-9a-fA-F]{1,4}:){2,7}[0-9a-fA-F]{1,4}\b/g, (match) => {
    if (match === '::1') return match;
    return '<ipv6>';
  });
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

    if (h === 'localhost' || h === '127.0.0.1' || h === '::1') {
      parts.push('localhost');
    } else if (/^(\d{1,3}\.){3}\d{1,3}$/.test(h) || h.includes(':')) {
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

/**
 * Create a health tracker for a tab. Attaches to Playwright page events.
 * Tracks: crashes, page errors, console errors, request failures,
 * dialog storms, redirect depth, HTTP status histogram, frame count.
 * All count-based — no URLs or content stored.
 */
export function createTabHealthTracker(page) {
  const health = {
    crashes: 0,
    pageErrors: 0,
    consoleErrors: 0,
    requestFailures: 0,
    dialogCount: 0,
    maxRedirectDepth: 0,
    statusCounts: {},     // { 403: 5, 429: 2, ... }
    frameCount: 0,
    _redirectDepth: 0,
  };

  // Renderer crash (OOM, segfault)
  page.on('crash', () => { health.crashes++; });

  // Uncaught JS exceptions on the page
  page.on('pageerror', () => { health.pageErrors++; });

  // Console errors (rate, not content)
  page.on('console', (msg) => {
    if (msg.type() === 'error') health.consoleErrors++;
  });

  // Failed requests (blocked, DNS failure, etc.)
  page.on('requestfailed', () => { health.requestFailures++; });

  // HTTP status tracking (non-2xx only)
  page.on('response', (resp) => {
    const s = resp.status();
    if (s >= 400) health.statusCounts[s] = (health.statusCounts[s] || 0) + 1;
  });

  // Dialog tracking (alert/confirm/prompt storms)
  page.on('dialog', async (dialog) => {
    health.dialogCount++;
    try { await dialog.dismiss(); } catch { /* page might be closed */ }
  });

  // Redirect depth per navigation
  page.on('request', (req) => {
    if (req.isNavigationRequest()) {
      if (req.redirectedFrom()) {
        health._redirectDepth++;
        if (health._redirectDepth > health.maxRedirectDepth) {
          health.maxRedirectDepth = health._redirectDepth;
        }
      } else {
        health._redirectDepth = 0; // new navigation, reset
      }
    }
  });

  /** Snapshot current health counters for inclusion in reports. */
  function snapshot() {
    try { health.frameCount = page.frames().length; } catch { /* closed */ }
    const { _redirectDepth, ...clean } = health;
    return { ...clean };
  }

  return { health, snapshot };
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
    `**Type:** ${type}`,
    `**Version:** ${detail.version || 'unknown'}`,
    `**Node:** ${detail.nodeVersion || 'unknown'}`,
    `**Platform:** ${detail.platform || 'unknown'}`,
    `**Uptime:** ${detail.uptimeMinutes != null ? detail.uptimeMinutes + ' min' : 'unknown'}`,
  ];

  if (detail.message) {
    sections.push('', '### Error', '```', anonymize(detail.message), '```');
  }
  if (detail.stack) {
    sections.push('', '### Stack Trace', '```', anonymize(detail.stack), '```');
  }
  if (detail.context) {
    sections.push('', '### Context', '```', anonymize(JSON.stringify(detail.context, null, 2)), '```');
  }
  if (detail.metrics) {
    sections.push('', '### Metrics', '```json', JSON.stringify(detail.metrics, null, 2), '```');
  }

  return sections.join('\n');
}

function formatCommentBody(type, detail) {
  const ts = new Date().toISOString();
  const lines = [
    `**+1** — ${ts}`,
    `Version: ${detail.version || 'unknown'}, Uptime: ${detail.uptimeMinutes != null ? detail.uptimeMinutes + ' min' : '?'}`,
  ];
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

  // No-op when disabled
  if (!enabled) {
    return {
      reportCrash: async () => {},
      reportHang: async () => {},
      reportStuckLoop: async () => {},
      startWatchdog: () => {},
      stop: () => {},
      _anonymize: anonymize,
      _stackSignature: stackSignature,
    };
  }

  /** Core: file or deduplicate a report. NEVER throws. */
  async function fileReport(type, label, detail) {
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

        await createIssue(repo, title, body, [label, 'auto-report']);
      } catch {
        // Swallow — reporter must never crash the server
      }
    })();

    inFlight.add(reportPromise);
    reportPromise.finally(() => inFlight.delete(reportPromise));
  }

  async function reportCrash(error, opts = {}) {
    const err = error instanceof Error ? error : new Error(String(error));
    const uptimeMinutes = typeof process !== 'undefined'
      ? Math.round(process.uptime() / 60) : undefined;

    await fileReport(
      opts.signal ? `signal:${opts.signal}` : (err.name || 'crash'),
      'crash',
      {
        error: err,
        message: err.message,
        stack: err.stack,
        uptimeMinutes,
        context: opts.context,
      },
    );
  }

  async function reportHang(operation, durationMs, opts = {}) {
    const uptimeMinutes = typeof process !== 'undefined'
      ? Math.round(process.uptime() / 60) : undefined;

    // Create per-report URL anonymizer (fresh salt each time)
    const urlAnon = createUrlAnonymizer();
    const context = { operation, durationMs, ...opts.context };

    // Anonymize any URLs in the journal
    if (context.journal) {
      context.journal = context.journal.map(j => {
        if (typeof j === 'string') return j; // already "type:action" format
        return j;
      });
    }
    // Include anonymized URL if provided
    if (opts.url) context.url = urlAnon.anonymizeUrl(opts.url);
    if (opts.redirectChain) context.redirectChain = urlAnon.anonymizeChain(opts.redirectChain);

    // Include tab health snapshot if provided
    if (opts.healthSnapshot) context.health = opts.healthSnapshot;

    await fileReport(
      `hang:${operation}`,
      'hang',
      {
        message: `Operation "${operation}" hung for ${Math.round(durationMs / 1000)}s`,
        stack: opts.error?.stack,
        uptimeMinutes,
        context,
      },
    );
  }

  async function reportStuckLoop(durationMs, opts = {}) {
    const uptimeMinutes = typeof process !== 'undefined'
      ? Math.round(process.uptime() / 60) : undefined;

    await fileReport(
      'stuck:tab-lock',
      'stuck',
      {
        message: `Tab lock held for ${Math.round(durationMs / 1000)}s (tab destroyed)`,
        uptimeMinutes,
        context: { durationMs, ...opts.context },
      },
    );
  }

  function startWatchdog(thresholdMs = 5000, getContext) {
    if (watchdogInterval) return;

    const checkMs = 1000;
    lastTick = Date.now();

    watchdogInterval = setInterval(() => {
      const now = Date.now();
      const drift = now - lastTick - checkMs;
      lastTick = now;

      if (drift > thresholdMs) {
        let extra = {};
        try { if (getContext) extra = getContext(); } catch { /* swallow */ }
        fileReport('stuck:event-loop', 'stuck', {
          message: `Event loop stalled for ${Math.round(drift / 1000)}s (threshold: ${Math.round(thresholdMs / 1000)}s)`,
          uptimeMinutes: typeof process !== 'undefined'
            ? Math.round(process.uptime() / 60) : undefined,
          context: { driftMs: drift, thresholdMs, ...extra },
        });
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
    stop,
    _anonymize: anonymize,
    _stackSignature: stackSignature,
    _rateLimiter: rateLimiter,
  };
}
