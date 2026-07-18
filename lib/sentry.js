/**
 * Sentry error tracking for camofox-browser.
 *
 * Isolated module — no process.env reads (config comes from lib/config.js).
 * No Express route handlers — safe from OpenClaw scanner rules.
 */

import * as Sentry from '@sentry/node';

let initialized = false;

/**
 * Initialize Sentry. Call once at startup with config from loadConfig().
 * No-ops gracefully if DSN is empty/missing.
 */
function shouldDropOperationalError(err, event) {
  if (err?.name === 'StaleRefsError') return true;

  const msg = err?.message || '';
  const stack = err?.stack || (event?.exception?.values?.flatMap(v => v?.stacktrace?.frames || []) || [])
    .map(frame => [frame?.filename, frame?.function].filter(Boolean).join(' '))
    .join('\n');

  if (
    msg.includes('Target page, context or browser has been closed') ||
    msg.includes('browser has been closed') ||
    msg.includes('Context closed') ||
    msg.includes('Browser closed') ||
    (msg.includes('Timeout') && msg.includes('exceeded')) ||
    msg.includes('timed out after') ||
    msg.includes('NS_ERROR_PROXY') ||
    msg.includes('NS_ERROR_ABORT') ||
    msg.includes('NS_ERROR_NET_INTERRUPT') ||
    msg.includes('NS_BINDING_ABORTED') ||
    msg.includes('Malformed value') ||
    msg.includes('Navigation aborted: tab deleted') ||
    msg === 'Tab destroyed' ||
    msg === 'Tab lock queue timeout' ||
    (msg.includes('strict mode violation') && msg.includes('resolved to')) ||
    msg.includes("Cannot read properties of undefined (reading '_getChildFrames')") ||
    stack.includes('_Page.addPageError') ||
    stack.includes('FFPage._onUncaughtError') ||
    stack.includes('FFPage._onNavigationCommitted')
  ) {
    return true;
  }

  return false;
}

function initSentry(config) {
  if (!config.sentryDsn) return;
  if (initialized) return;

  Sentry.init({
    dsn: config.sentryDsn,
    environment: config.nodeEnv,
    release: config.version || undefined,
    tracesSampleRate: 0.1,
    beforeSend(event, hint) {
      const err = hint?.originalException;
      if (shouldDropOperationalError(err, event)) return null;
      return event;
    },
  });

  if (config.flyMachineId) {
    Sentry.setTag('fly.machine_id', config.flyMachineId);
  }
  if (config.flyAppName) {
    Sentry.setTag('fly.app', config.flyAppName);
  }

  initialized = true;
}

/**
 * Capture an exception in Sentry with optional context.
 * No-ops if Sentry is not initialized.
 */
function captureException(err, context) {
  if (!initialized) return;
  Sentry.captureException(err, context ? { extra: context } : undefined);
}

/**
 * Set user context on the current scope.
 */
function setUser(userId) {
  if (!initialized) return;
  Sentry.setUser({ id: userId });
}

/**
 * Install Sentry's Express error handler on the app.
 * Must be called AFTER all routes are registered.
 */
function setupExpressErrorHandler(app) {
  if (!initialized) return;
  Sentry.setupExpressErrorHandler(app);
}

/**
 * Flush pending events (call before process exit).
 */
async function flush(timeoutMs = 2000) {
  if (!initialized) return;
  await Sentry.flush(timeoutMs);
}

export { initSentry, captureException, setUser, setupExpressErrorHandler, flush, shouldDropOperationalError };
