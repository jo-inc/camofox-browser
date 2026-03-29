import crypto from 'crypto';

function decodeProxyCredential(value) {
  if (!value) return value;

  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

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

function makeSessionId(prefix = 'sess') {
  return `${prefix}-${crypto.randomUUID().replace(/-/g, '').slice(0, 12)}`;
}

export function normalizePlaywrightProxy(proxy) {
  if (!proxy) return proxy;

  return {
    ...proxy,
    username: decodeProxyCredential(proxy.username),
    password: decodeProxyCredential(proxy.password),
  };
}

export function buildDecodoBackconnectUsername(baseUsername, options = {}) {
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
}

function buildBackconnectProxy(config, sessionId) {
  const username = buildDecodoBackconnectUsername(config.username, {
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
 * - round_robin: legacy per-context port rotation across a small fixed pool
 * - backconnect: Decodo residential backconnect endpoint with sticky session usernames
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
  } = config;

  if (strategy === 'backconnect') {
    if (!backconnectHost || !backconnectPort || !username || !password) return null;

    return {
      mode: 'backconnect',
      size: 1,

      getLaunchProxy(sessionId = makeSessionId('browser')) {
        return buildBackconnectProxy(config, sessionId);
      },

      getNext(sessionId = makeSessionId('ctx')) {
        return buildBackconnectProxy(config, sessionId);
      },
    };
  }

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
