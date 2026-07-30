// Optional Sentry integration. This module must be safe when @sentry/node is
// not installed or SENTRY_DSN is unset; error reporting should never prevent the
// browser server from starting.

let sentry = null;
let initPromise = null;
let enabled = false;

export function initSentry(config = {}) {
  const dsn = config.sentryDsn || config.SENTRY_DSN || process.env.SENTRY_DSN || '';
  if (!dsn) return;

  enabled = true;
  initPromise = import('@sentry/node')
    .then((mod) => {
      sentry = mod;
      sentry.init({
        dsn,
        environment: config.nodeEnv || process.env.NODE_ENV || 'development',
        release: config.version ? `camofox-browser@${config.version}` : undefined,
      });
    })
    .catch(() => {
      enabled = false;
      sentry = null;
    });
}

export function captureException(error, context = {}) {
  if (!enabled || !error) return;
  if (!sentry) {
    initPromise?.then(() => captureException(error, context)).catch(() => {});
    return;
  }

  try {
    sentry.withScope((scope) => {
      for (const [key, value] of Object.entries(context || {})) {
        if (key === 'userId' && value != null) {
          scope.setUser({ id: String(value) });
        } else {
          scope.setExtra(key, value);
        }
      }
      sentry.captureException(error);
    });
  } catch {}
}

export function sanitizeRequestPath(req) {
  if (typeof req?.path === 'string') return req.path;
  if (typeof req?.originalUrl === 'string') return req.originalUrl.split('?', 1)[0];
  return undefined;
}

export function setupExpressErrorHandler(app) {
  if (!app) return;
  app.use((err, req, res, next) => {
    captureException(err, {
      path: sanitizeRequestPath(req),
      method: req?.method,
      userId: req?.query?.userId || req?.body?.userId,
      reqId: req?.reqId,
    });
    next(err);
  });
}

export async function flush(timeoutMs = 2000) {
  if (!enabled) return false;
  try {
    if (initPromise) await initPromise;
    if (!sentry?.flush) return false;
    return await sentry.flush(timeoutMs);
  } catch {
    return false;
  }
}
