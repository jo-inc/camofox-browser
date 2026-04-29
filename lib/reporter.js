// lib/reporter.js -- Crash/hang reporter for camofox-browser
// Files GitHub issues with paranoid anonymization. No env reads here.
// Config passed via createReporter(config) from lib/config.js.

import crypto from 'crypto';
import { monitorEventLoopDelay } from 'perf_hooks';
import { collectResourceSnapshot, classifyProxyError } from './resources.js';

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
 * Better to over-strip than leak. Order matters -- more specific patterns first.
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

  // 3. Strip proxy URLs with credentials (before email -- email regex eats user:pass@host)
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
 * stack frame (file:line, not column -- columns shift with minor edits).
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

/** FNV-1a hash -> 8-char hex. Stable bucketing, not crypto. */
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
// These are public knowledge -- showing "amazon.com" in a crash report is not PII.
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

// Stable key for domain hashing -- NOT a secret, just ensures consistent hashes
// across reports so we can correlate "site-a1b2c3d4 caused 12 hangs this week".
const DOMAIN_HASH_KEY = 'camofox-domain-hash-v1';

/**
 * Create a URL anonymizer.
 * Public domains shown verbatim. Private domains get a stable hash
 * (same domain -> same hash across all reports, enabling correlation).
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
   *   https://challenges.cloudflare.com/[path]/[path]/[path]
   *   https://site-a1b2c3d4:8443/[path]/[path] ?[3] #[frag]
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
 * All count-based -- no URLs or content stored.
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

  // Auto-dismiss dialogs to prevent page hangs (not tracked as a metric -- noise)
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
   * Use a tight timeout -- if the renderer is crashed, evaluate will hang.
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

// collectResourceSnapshot and classifyProxyError live in lib/resources.js
// (isolated from network code for clean separation of concerns).
// Re-exported here for backward compatibility.
export { collectResourceSnapshot, classifyProxyError };

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
// Crash relay client
// ============================================================================

// Reports are sent to a Cloudflare Worker relay. All credentials are
// environment secrets on the relay -- nothing sensitive ships in this package.
//
// Default relay: https://camofox-crash-relay.askjo.workers.dev
// Override:      CAMOFOX_CRASH_REPORT_URL=https://your-own-relay/report
//
// The relay source lives at workers/crash-reporter/index.ts in this repo.
// Verify: GET /source returns { commit, sha256 } to compare against the repo.
// Full source: https://github.com/jo-inc/camofox-browser/blob/main/workers/crash-reporter/index.ts

const DEFAULT_RELAY_URL = 'https://camofox-crash-relay.askjo.workers.dev/report';
const FETCH_TIMEOUT_MS = 5000;

let _relayUrl = DEFAULT_RELAY_URL;

function fetchWithTimeout(url, options) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  return fetch(url, { ...options, signal: controller.signal })
    .finally(() => clearTimeout(timer));
}

/**
 * Send a crash report to the relay. Returns true if accepted.
 * Never throws -- reporter must never crash the server.
 */
export async function sendToRelay(payload) {
  try {
    const resp = await fetchWithTimeout(_relayUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    return resp.ok || resp.status === 429; // rate-limited is fine, not an error
  } catch {
    return false;
  }
}

// ============================================================================
// Issue formatting
// ============================================================================

function formatIssueBody(type, detail) {
  const sections = [
    '> Auto-reported by camofox-crash-reporter. All data is anonymized.',
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
    if (b.redirectStatusCodes?.length) sections.push(`- **redirect statuses:** ${b.redirectStatusCodes.join(' -> ')}`);
  }

  // Proxy info (safe fields only -- no IPs, credentials, or hostnames)
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
    if (s.classification) sections.push(`- **classification:** ${s.classification}`);
    if (s.cpuElapsedS != null) sections.push(`- **CPU time during stall:** ${s.cpuElapsedS}s`);
    if (s.cpuRatio != null) sections.push(`- **CPU/wall ratio:** ${s.cpuRatio}`);
    if (s.sigcontInWindow != null) sections.push(`- **SIGCONT in window:** ${s.sigcontInWindow}`);
    if (s.hrtimeWallDriftS != null) sections.push(`- **hrtime<->wall drift:** ${s.hrtimeWallDriftS}s`);
    if (s.eventLoopDelay) {
      const eld = s.eventLoopDelay;
      sections.push(`- **event loop delay:** p50=${eld.p50Ms}ms p99=${eld.p99Ms}ms max=${eld.maxMs}ms`);
    }
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
  // Set relay URL (env override for self-hosted relays)
  _relayUrl = config.crashReportUrl || DEFAULT_RELAY_URL;

  const enabled = config.crashReportEnabled !== false;
  const repo = config.crashReportRepo || 'jo-inc/camofox-browser';
  const rateLimiters = {
    crash: new RateLimiter(5),   // 5 crashes/hr
    hang: new RateLimiter(5),    // 5 hangs/hr
    stuck: new RateLimiter(2),   // 2 stalls/hr (with active tabs only)
    leak: new RateLimiter(2),    // 2 leak alerts/hr
    _default: new RateLimiter(config.crashReportRateLimit || 10),
  };
  const version = config.version || 'unknown';

  let watchdogInterval = null;
  let _resetNativeMemBaseline = false; // Set by resetNativeMemBaseline(), read by watchdog
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

  /** Core: build and send a report to the relay. NEVER throws. */
  async function fileReport(type, labels, detail) {
    const bucket = type.startsWith('stuck:') ? 'stuck' : type.startsWith('hang:') ? 'hang' : type.startsWith('leak:') ? 'leak' : 'crash';
    const limiter = rateLimiters[bucket] || rateLimiters._default;
    if (!limiter.tryAcquire()) return;

    const reportPromise = (async () => {
      try {
        const sig = stackSignature(type, detail.error || { message: detail.message, stack: detail.stack });
        const safeMessage = anonymize(detail.message || detail.error?.message || type);
        const title = `[${sig}] ${type}: ${safeMessage.slice(0, 120)}`;

        const body = formatIssueBody(type, {
          ...detail,
          version,
          nodeVersion: typeof process !== 'undefined' ? process.version : 'unknown',
          platform: typeof process !== 'undefined' ? process.platform : 'unknown',
        });

        const issueLabels = Array.isArray(labels) ? labels : [labels, 'auto-report'];

        await sendToRelay({
          type,
          signature: sig,
          title,
          body,
          labels: issueLabels,
          version,
        });
      } catch {
        // Swallow -- reporter must never crash the server
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
    lastTick = Date.now();
    let lastCpuUsage = process.cpuUsage();
    let lastHrtime = process.hrtime.bigint();
    let lastHeapUsed = process.memoryUsage().heapUsed;

    // --- Native memory leak tracking ---
    // Track RSS minus JS heap over time to detect native/external memory leaks.
    // Sample every 30s, alert if native memory grows by >200MB from baseline.
    let nativeMemBaseline = null; // RSS - heapUsed at first measurement
    let nativeMemHighWater = 0;
    let lastNativeMemCheck = 0;
    const NATIVE_MEM_CHECK_INTERVAL_MS = 30_000;
    const NATIVE_MEM_LEAK_THRESHOLD_MB = 200; // alert if native mem exceeds baseline by this much
    let nativeMemAlertFired = false;

    // SIGCONT detection -- macOS sends SIGCONT on wake from sleep/suspend
    let lastSigcont = 0;
    try { process.on('SIGCONT', () => { lastSigcont = Date.now(); }); } catch { /* unavailable */ }

    // Event loop delay histogram (perf_hooks) -- correlating evidence
    let elHistogram = null;
    try {
      elHistogram = monitorEventLoopDelay({ resolution: 20 });
      elHistogram.enable();
    } catch { /* unavailable */ }

    // Suppress false positives from OS sleep/suspend (laptop lid close, VM pause).
    // Stalls > 120s are almost certainly not event-loop bugs.
    const MAX_REPORTABLE_DRIFT_MS = 60_000;
    let suppressTicksRemaining = 0;
    const SUPPRESS_TICKS_AFTER_WAKE = 5;

    watchdogInterval = setInterval(() => {
      const now = Date.now();
      const drift = now - lastTick - checkMs;
      const cpuDelta = process.cpuUsage(lastCpuUsage);
      const hrtimeNow = process.hrtime.bigint();
      const hrtimeDeltaMs = Number(hrtimeNow - lastHrtime) / 1e6;

      lastTick = now;
      lastCpuUsage = process.cpuUsage();
      lastHrtime = hrtimeNow;

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

      // --- Native memory leak detection (runs every ~30s) ---
      if (now - lastNativeMemCheck >= NATIVE_MEM_CHECK_INTERVAL_MS) {
        lastNativeMemCheck = now;
        try {
          // Check if baseline should be reset (e.g. after browser close)
          if (_resetNativeMemBaseline) {
            nativeMemBaseline = null;
            nativeMemHighWater = 0;
            nativeMemAlertFired = false;
            _resetNativeMemBaseline = false;
          }
          const mem = process.memoryUsage();
          const nativeMemMb = Math.round((mem.rss - mem.heapUsed) / 1048576);
          if (nativeMemBaseline === null) {
            nativeMemBaseline = nativeMemMb;
          }
          nativeMemHighWater = Math.max(nativeMemHighWater, nativeMemMb);
          const growth = nativeMemMb - nativeMemBaseline;

          if (growth > NATIVE_MEM_LEAK_THRESHOLD_MB && !nativeMemAlertFired) {
            nativeMemAlertFired = true;
            let extra = {};
            try { if (getContext) extra = getContext(); } catch { /* swallow */ }
            const resources = collectResourceSnapshot(extra.resourceOpts || {});
            delete extra.resourceOpts;

            fileReport('leak:native-memory', ['auto-report', 'memory-leak'], {
              message: `Native memory grew by ${growth}MB (baseline: ${nativeMemBaseline}MB, current: ${nativeMemMb}MB, high-water: ${nativeMemHighWater}MB)`,
              uptimeMinutes: Math.round(process.uptime() / 60),
              resources,
              nativeMemory: {
                baselineMb: nativeMemBaseline,
                currentMb: nativeMemMb,
                highWaterMb: nativeMemHighWater,
                growthMb: growth,
                rssMb: Math.round(mem.rss / 1048576),
                heapUsedMb: Math.round(mem.heapUsed / 1048576),
                externalMb: Math.round(mem.external / 1048576),
              },
              context: extra,
            });
          }
        } catch { /* swallow */ }
      }

      if (drift > thresholdMs) {
        // CPU time consumed during the stall interval (user + system, in seconds)
        const cpuElapsedS = (cpuDelta.user + cpuDelta.system) / 1e6;
        const wallElapsedS = drift / 1000;
        const cpuRatio = wallElapsedS > 0 ? cpuElapsedS / wallElapsedS : 0;

        // SIGCONT within the stall window = OS sleep/resume
        const sigcontInWindow = lastSigcont > 0 && (now - lastSigcont) < drift + 2000;

        // hrtime vs wall clock drift (macOS: hrtime doesn't advance during sleep)
        const hrtimeWallDriftS = Math.abs((drift - (hrtimeDeltaMs - checkMs))) / 1000;

        // Classify: sleep vs real stall
        let classification;
        if (cpuRatio < 0.01 && sigcontInWindow) classification = 'sleep';
        else if (cpuRatio < 0.001) classification = 'likely_sleep';
        else if (cpuRatio < 0.01) classification = 'likely_sleep';
        else if (cpuRatio > 0.1) classification = 'real_stall';
        else classification = 'ambiguous';

        // Don't file reports for definitive sleep
        if (classification === 'sleep') {
          lastHeapUsed = process.memoryUsage().heapUsed;
          return;
        }

        // Capture heap delta during stall (GC indicator)
        const currentHeap = process.memoryUsage().heapUsed;
        const heapDeltaMb = Math.round((currentHeap - lastHeapUsed) / 1048576);
        lastHeapUsed = currentHeap;

        let extra = {};
        try { if (getContext) extra = getContext(); } catch { /* swallow */ }

        const resources = collectResourceSnapshot(extra.resourceOpts || {});
        // Remove resourceOpts from extra so it doesn't end up in context
        delete extra.resourceOpts;

        // Don't report idle-server stalls -- no user impact
        if ((resources.activeTabs || 0) === 0 && (resources.browserContexts || 0) === 0) {
          return;
        }

        // Event loop delay histogram snapshot
        let elDelay = null;
        if (elHistogram) {
          try {
            elDelay = {
              p50Ms: Math.round(elHistogram.percentile(50) / 1e6),
              p99Ms: Math.round(elHistogram.percentile(99) / 1e6),
              maxMs: Math.round(elHistogram.max / 1e6),
            };
            elHistogram.reset();
          } catch { /* unavailable */ }
        }

        const labels = ['stuck', 'auto-report'];
        if (classification === 'likely_sleep') labels.push('likely-sleep');

        fileReport('stuck:event-loop', labels, {
          message: `Event loop stalled for ${Math.round(drift / 1000)}s (threshold: ${Math.round(thresholdMs / 1000)}s)`,
          // Stable signature: duration is NOT included -- all stalls on the same route dedup
          error: { name: 'EventLoopStall', message: _lastRoute || 'idle', stack: '' },
          uptimeMinutes: typeof process !== 'undefined'
            ? Math.round(process.uptime() / 60) : undefined,
          resources,
          stall: {
            driftMs: drift,
            thresholdMs,
            classification,
            cpuElapsedS: Math.round(cpuElapsedS * 1000) / 1000,
            cpuRatio: Math.round(cpuRatio * 10000) / 10000,
            sigcontInWindow,
            hrtimeWallDriftS: Math.round(hrtimeWallDriftS * 100) / 100,
            eventLoopDelay: elDelay,
            lastRoute: _lastRoute,
            activeHandles: resources.activeHandles,
            activeRequests: resources.activeRequests,
            heapDeltaMb,
            nativeMemGrowthMb: nativeMemBaseline !== null
              ? Math.round((resources.nodeRssMb - resources.nodeHeapUsedMb) - nativeMemBaseline)
              : null,
            nativeMemBaselineMb: nativeMemBaseline,
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

  /**
   * Reset native memory baseline. Call after browser close so the next
   * browser session measures from a fresh baseline, not the old one.
   */
  function resetNativeMemBaseline() {
    // These are closure vars in startWatchdog -- we need to reach them.
    // Since this runs in the same module, we set a flag the watchdog reads.
    _resetNativeMemBaseline = true;
  }

  return {
    reportCrash,
    reportHang,
    reportStuckLoop,
    startWatchdog,
    trackRoute,
    stop,
    resetNativeMemBaseline,
    _anonymize: anonymize,
    _stackSignature: stackSignature,
    _rateLimiter: rateLimiters,
  };
}
