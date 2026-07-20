const ALLOWED_PROXY_SCHEMES = new Set(['http:', 'https:', 'socks4:', 'socks5:']);
const MAX_PROXY_SERVER_LENGTH = 2048;
const MAX_PROXY_CREDENTIAL_LENGTH = 512;

function proxyError(message, statusCode = 400) {
  return Object.assign(new Error(message), { statusCode });
}

export function redactProxy(proxy) {
  if (!proxy) return null;
  return {
    server: proxy.server,
    username: proxy.username ? '<redacted>' : undefined,
    password: proxy.password ? '<redacted>' : undefined,
  };
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

export function resolveRequestProxy({ requestedProxy, existingSession, globalProxyActive }) {
  if (requestedProxy === undefined) return null;
  const proxy = normalizeRequestProxy(requestedProxy);

  if (globalProxyActive) {
    throw proxyError('request-level proxy cannot be used while global proxy configuration is active', 409);
  }

  if (existingSession) {
    if (requestProxiesEqual(proxy, existingSession.requestProxy || null)) {
      return proxy;
    }
    throw proxyError('proxy can only be set when creating a new user session; existing session uses a different proxy', 409);
  }

  return proxy;
}
