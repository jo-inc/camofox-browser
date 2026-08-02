const ALLOWED_PROXY_SCHEMES = new Set(['http:', 'https:', 'socks4:', 'socks5:']);
const MAX_PROXY_SERVER_LENGTH = 2048;
const MAX_PROXY_CREDENTIAL_LENGTH = 512;
const DEFAULT_RECOVERY_TTL_MS = 5 * 60 * 1000;
const DEFAULT_MAX_RECOVERY_ENTRIES = 256;
const ALLOWED_PROXY_FIELDS = new Set(['server', 'username', 'password']);
export const REQUEST_PROXY_RECOVERY_REASONS = Object.freeze([
  'route_dead_context',
  'dead_context',
  'browser_disconnected',
  'navigation_timeout',
  'new_page_unresponsive',
  'pressure_cleanup_empty_session',
  'session_timeout',
  'memory_pressure',
  'tab_reaper_empty_session',
]);
const AUTOMATIC_RECOVERY_REASONS = new Set(REQUEST_PROXY_RECOVERY_REASONS);

function proxyError(message, statusCode = 400, { code = null, recovery = null, retryable } = {}) {
  return Object.assign(new Error(message), {
    statusCode,
    ...(code ? { code } : {}),
    ...(recovery ? { recovery } : {}),
    ...(retryable !== undefined ? { retryable } : {}),
  });
}

function copyProxy(proxy) {
  if (!proxy) return null;
  return {
    server: proxy.server,
    ...(proxy.username !== undefined ? { username: proxy.username } : {}),
    ...(proxy.password !== undefined ? { password: proxy.password } : {}),
  };
}

export function redactProxy(proxy) {
  if (!proxy) return null;
  return {
    server: proxy.server,
    username: proxy.username ? '<redacted>' : undefined,
    password: proxy.password ? '<redacted>' : undefined,
  };
}

export function shouldPreserveRequestProxy(reason) {
  return AUTOMATIC_RECOVERY_REASONS.has(reason) || reason?.startsWith('browser_restart:') === true;
}

function validateOptionalCredential(value, field) {
  if (value === undefined) return undefined;
  if (typeof value !== 'string') {
    throw proxyError(`proxy.${field} must be a string`);
  }
  if (value.length > MAX_PROXY_CREDENTIAL_LENGTH) {
    throw proxyError(`proxy.${field} is too long`);
  }
  return value;
}

export function normalizeRequestProxy(proxy) {
  if (proxy === undefined) return null;
  if (!proxy || typeof proxy !== 'object' || Array.isArray(proxy)) {
    throw proxyError('proxy must be an object');
  }
  const unsupportedField = Object.keys(proxy).find(field => !ALLOWED_PROXY_FIELDS.has(field));
  if (unsupportedField) {
    throw proxyError('proxy contains unsupported fields');
  }
  if (typeof proxy.server !== 'string' || !proxy.server.trim()) {
    throw proxyError('proxy.server is required');
  }

  const server = proxy.server.trim();
  if (server.length > MAX_PROXY_SERVER_LENGTH) {
    throw proxyError('proxy.server is too long');
  }

  let parsed;
  try {
    parsed = new URL(server);
  } catch {
    throw proxyError('proxy.server must be a valid URL');
  }
  if (!ALLOWED_PROXY_SCHEMES.has(parsed.protocol)) {
    throw proxyError('proxy.server scheme must be http, https, socks4, or socks5');
  }
  if (!parsed.hostname) {
    throw proxyError('proxy.server must include a hostname');
  }
  if (parsed.username || parsed.password) {
    throw proxyError('proxy credentials must be provided as proxy.username/proxy.password, not embedded in proxy.server');
  }

  const username = validateOptionalCredential(proxy.username, 'username');
  const password = validateOptionalCredential(proxy.password, 'password');
  return {
    server,
    ...(username !== undefined ? { username } : {}),
    ...(password !== undefined ? { password } : {}),
  };
}

export function requestProxiesEqual(a, b) {
  const left = a || null;
  const right = b || null;
  if (!left || !right) return left === right;
  return left.server === right.server &&
    (left.username || '') === (right.username || '') &&
    (left.password || '') === (right.password || '');
}

export function requestProxyConflict(message = 'existing session uses a different proxy') {
  return proxyError(message, 409, {
    code: 'proxy_conflict',
    recovery: 'delete_session',
    retryable: false,
  });
}

export function assertRequestProxyCompatible(expectedProxy, actualProxy) {
  if (!requestProxiesEqual(expectedProxy, actualProxy)) throw requestProxyConflict();
  return actualProxy || null;
}

export function resolveRequestProxy({ requestedProxy, existingSession, globalProxyActive }) {
  if (requestedProxy === undefined) return null;
  const proxy = normalizeRequestProxy(requestedProxy);

  if (globalProxyActive) {
    throw proxyError(
      'request-level proxy cannot be used while global proxy configuration is active',
      409,
      { code: 'proxy_mode_conflict', recovery: 'remove_request_proxy', retryable: false },
    );
  }

  if (existingSession) {
    if (requestProxiesEqual(proxy, existingSession.requestProxy || null)) {
      return proxy;
    }
    throw requestProxyConflict('proxy can only be set when creating a new user session; existing session uses a different proxy');
  }

  return proxy;
}

export function createRequestProxyRecoveryCache({
  ttlMs = DEFAULT_RECOVERY_TTL_MS,
  maxEntries = DEFAULT_MAX_RECOVERY_ENTRIES,
  now = Date.now,
} = {}) {
  const entries = new Map();
  const boundedTtlMs = Math.max(1, Number(ttlMs) || DEFAULT_RECOVERY_TTL_MS);
  const boundedMaxEntries = Math.max(1, Math.floor(Number(maxEntries) || DEFAULT_MAX_RECOVERY_ENTRIES));

  function pruneExpired(at = now()) {
    for (const [userId, entry] of entries) {
      if (entry.expiresAt <= at) entries.delete(userId);
    }
  }

  return {
    remember(userId, proxy) {
      const key = String(userId);
      if (!proxy) {
        entries.delete(key);
        return;
      }
      const at = now();
      pruneExpired(at);
      entries.delete(key);
      while (entries.size >= boundedMaxEntries) {
        const oldestKey = entries.keys().next().value;
        entries.delete(oldestKey);
      }
      entries.set(key, {
        proxy: copyProxy(proxy),
        expiresAt: at + boundedTtlMs,
      });
    },

    get(userId) {
      const at = now();
      pruneExpired(at);
      return copyProxy(entries.get(String(userId))?.proxy || null);
    },

    delete(userId) {
      return entries.delete(String(userId));
    },

    clear() {
      entries.clear();
    },

    get size() {
      pruneExpired(now());
      return entries.size;
    },
  };
}
