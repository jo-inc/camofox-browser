import crypto from 'crypto';

// ---------------------------------------------------------------------------
// Credential helpers
// ---------------------------------------------------------------------------

function decodeProxyCredential(value) {
  if (!value) return value;
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

export function normalizePlaywrightProxy(proxy) {
  if (!proxy) return proxy;
  return {
    ...proxy,
    username: decodeProxyCredential(proxy.username),
    password: decodeProxyCredential(proxy.password),
  };
}

// ---------------------------------------------------------------------------
// Session helpers
// ---------------------------------------------------------------------------

function makeSessionId(prefix = 'sess') {
  return `${prefix}-${crypto.randomUUID().replace(/-/g, '').slice(0, 12)}`;
}

// ---------------------------------------------------------------------------
// Provider interface
// ---------------------------------------------------------------------------
//
// A proxy provider shapes credentials and declares capabilities.
//
//   {
//     name:              string   — e.g. 'decodo', 'brightdata', 'generic'
//     canRotateSessions: bool     — per-context session rotation supported
//     launchRetries:     number   — how many browser launch attempts
//     launchTimeoutMs:   number   — per-attempt timeout
//     buildSessionUsername(baseUsername, options) → string
//     buildProxyUrl(proxy, config) → string | null
//   }
//
// options: { country, state, city, zip, sessionId, sessionDurationMinutes }
// ---------------------------------------------------------------------------

function sanitizeBackconnectValue(value) {
  if (!value) return '';
  return String(value)
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '_')
    .replace(/[^a-z0-9_]/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '');
}

/**
 * Decodo residential proxy provider.
 * Username DSL: user-{base}-country-{cc}-state-{st}-session-{id}-sessionduration-{min}
 */
export const decodoProvider = {
  name: 'decodo',
  canRotateSessions: true,
  launchRetries: 10,
  launchTimeoutMs: 180000,

  buildSessionUsername(baseUsername, options = {}) {
    const username = sanitizeBackconnectValue(baseUsername);
    if (!username) return '';

    const parts = [`user-${username}`];
    const country = sanitizeBackconnectValue(options.country);
    const state = sanitizeBackconnectValue(options.state);
    const city = sanitizeBackconnectValue(options.city);
    const zip = sanitizeBackconnectValue(options.zip);
    const sessionId = sanitizeBackconnectValue(options.sessionId);
    const sessionDurationMinutes = Number.isFinite(options.sessionDurationMinutes)
      ? Math.max(1, Math.min(1440, Math.trunc(options.sessionDurationMinutes)))
      : null;

    if (country) parts.push(`country-${country}`);
    if (state) parts.push(`state-${state}`);
    if (city) parts.push(`city-${city}`);
    if (zip) parts.push(`zip-${zip}`);
    if (sessionId) parts.push(`session-${sessionId}`);
    if (sessionDurationMinutes) parts.push(`sessionduration-${sessionDurationMinutes}`);

    return parts.join('-');
  },

  buildProxyUrl(proxy, config) {
    if (!proxy?.username || !config?.password) return null;
    const user = encodeURIComponent(proxy.username);
    const pass = encodeURIComponent(config.password);
    const host = config.backconnectHost;
    const port = config.backconnectPort;
    return `http://${user}:${pass}@${host}:${port}`;
  },
};

/**
 * Generic backconnect provider — no username rewriting, just pass-through.
 * Works with any SOCKS/HTTP proxy that supports sticky sessions via
 * separate session IDs in the username field (e.g. BrightData, Oxylabs).
 */
export const genericBackconnectProvider = {
  name: 'generic',
  canRotateSessions: true,
  launchRetries: 5,
  launchTimeoutMs: 120000,

  buildSessionUsername(baseUsername, options = {}) {
    // Simple pass-through: base username + session suffix
    const base = String(baseUsername || '').trim();
    const sessionId = options.sessionId ? `-${String(options.sessionId).trim()}` : '';
    return `${base}${sessionId}`;
  },

  buildProxyUrl(proxy, config) {
    if (!proxy?.username || !config?.password) return null;
    const user = encodeURIComponent(proxy.username);
    const pass = encodeURIComponent(config.password);
    const host = config.backconnectHost;
    const port = config.backconnectPort;
    return `http://${user}:${pass}@${host}:${port}`;
  },
};

// Provider registry
const providers = {
  decodo: decodoProvider,
  generic: genericBackconnectProvider,
};

export function getProvider(name) {
  return providers[name] || null;
}

export function registerProvider(name, provider) {
  providers[name] = provider;
}

// ---------------------------------------------------------------------------
// Proxy pool factory
// ---------------------------------------------------------------------------

function buildBackconnectProxy(config, provider, sessionId) {
  const username = provider.buildSessionUsername(config.username, {
    country: config.country,
    state: config.state,
    city: config.city,
    zip: config.zip,
    sessionId,
    sessionDurationMinutes: config.sessionDurationMinutes,
  });

  return {
    server: `http://${config.backconnectHost}:${config.backconnectPort}`,
    username,
    password: config.password,
    sessionId,
  };
}

/**
 * Create proxy strategy helpers.
 * - round_robin: per-context port rotation across a fixed pool
 * - backconnect: residential backconnect endpoint with sticky sessions (provider-shaped)
 */
export function createProxyPool(config) {
  const {
    strategy = 'round_robin',
    host,
    ports,
    username,
    password,
    backconnectHost,
    backconnectPort,
    providerName,
  } = config;

  if (strategy === 'backconnect') {
    if (!backconnectHost || !backconnectPort || !username || !password) return null;

    const provider = getProvider(providerName || 'decodo') || decodoProvider;

    return {
      mode: 'backconnect',
      provider,
      canRotateSessions: provider.canRotateSessions,
      launchRetries: provider.launchRetries,
      launchTimeoutMs: provider.launchTimeoutMs,
      size: 1,

      getLaunchProxy(sessionId = makeSessionId('browser')) {
        return buildBackconnectProxy(config, provider, sessionId);
      },

      getNext(sessionId = makeSessionId('ctx')) {
        return buildBackconnectProxy(config, provider, sessionId);
      },
    };
  }

  // round_robin — no session rotation, single attempt
  if (!host || !ports || ports.length === 0) return null;

  let index = 0;

  function makeProxy(port) {
    return {
      server: `http://${host}:${port}`,
      username,
      password,
    };
  }

  return {
    mode: 'round_robin',
    provider: null,
    canRotateSessions: false,
    launchRetries: 1,
    launchTimeoutMs: 60000,
    size: ports.length,

    getLaunchProxy() {
      return makeProxy(ports[0]);
    },

    getNext() {
      const port = ports[index % ports.length];
      index++;
      return makeProxy(port);
    },
  };
}

// ---------------------------------------------------------------------------
// URL builder (for CLI tools like yt-dlp)
// ---------------------------------------------------------------------------

/**
 * Build a proxy URL string (http://user:pass@host:port) suitable for
 * CLI tools like yt-dlp --proxy.
 */
export function buildProxyUrl(pool, config) {
  if (!pool) return null;

  if (pool.mode === 'backconnect') {
    const proxy = pool.getLaunchProxy(makeSessionId('ytdlp'));
    if (pool.provider?.buildProxyUrl) {
      return pool.provider.buildProxyUrl(proxy, config);
    }
    // Fallback for pools without provider
    if (!proxy?.username || !config?.password) return null;
    const user = encodeURIComponent(proxy.username);
    const pass = encodeURIComponent(config.password);
    return `http://${user}:${pass}@${config.backconnectHost}:${config.backconnectPort}`;
  }

  // round_robin — pick the first port
  if (!config?.host || !config?.ports?.length) return null;
  const user = config.username ? encodeURIComponent(config.username) : '';
  const pass = config.password ? encodeURIComponent(config.password) : '';
  const auth = user ? `${user}:${pass}@` : '';
  return `http://${auth}${config.host}:${config.ports[0]}`;
}

// Legacy alias for backward compatibility
export function buildDecodoBackconnectUsername(baseUsername, options) {
  return decodoProvider.buildSessionUsername(baseUsername, options);
}
