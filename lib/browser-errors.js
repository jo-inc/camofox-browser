import crypto from 'crypto';

export function safePageUrl(page) {
  try { return page?.url?.() || 'unknown'; } catch { return 'unknown'; }
}

export function urlDomain(url) {
  try {
    const parsed = new URL(url);
    return parsed.hostname || 'unknown';
  } catch {
    return 'unknown';
  }
}

export function hashIdentifier(value) {
  if (value === undefined || value === null || value === '') return null;
  return crypto.createHash('sha256').update(String(value)).digest('hex').slice(0, 12);
}

export function isDeadContextError(err) {
  const msg = err && err.message || '';
  return msg.includes('Target page, context or browser has been closed') ||
         msg.includes('browser has been closed') ||
         msg.includes('Context closed') ||
         msg.includes('Browser closed');
}

export function isPageCrashedError(err) {
  const msg = err && err.message || '';
  return msg.includes('Page crashed') ||
         msg.includes('Target crashed') ||
         msg.includes('crashed page');
}

export function isTimeoutError(err) {
  const msg = err && err.message || '';
  return msg.includes('timed out after') ||
         (msg.includes('Timeout') && msg.includes('exceeded'));
}

export function isTabLockQueueTimeout(err) {
  return err && err.message === 'Tab lock queue timeout';
}

export function isTabDestroyedError(err) {
  return err && err.message === 'Tab destroyed';
}

export function isStaleRefsError(err) {
  return err?.code === 'stale_refs' || err?.name === 'StaleRefsError';
}

export function isUserConcurrencyTimeout(err) {
  const msg = err && err.message || '';
  return msg.includes('User concurrency limit reached') || msg.includes('concurrency limit reached');
}

export function isBrowserLaunchError(err) {
  const msg = err && err.message || '';
  return msg.includes('Browser launch timeout') || msg.includes('Failed to launch');
}

export function isNavigationRaceError(err) {
  const msg = err && err.message || '';
  return msg.includes('Execution context was destroyed') ||
         msg.includes('Cannot find context with specified id') ||
         msg.includes('Frame was detached') ||
         msg.includes('Navigation failed because page was closed') ||
         msg.includes('Navigation interrupted') ||
         msg.includes('NS_ERROR_ABORT') ||
         msg.includes('ERR_ABORTED');
}

export function isInvalidSelectorError(err) {
  if (err?.code === 'invalid_selector') return true;
  const msg = err && err.message || '';
  return msg.includes('Unexpected token') && msg.includes('selector') ||
         msg.includes('Unsupported token') && msg.includes('selector') ||
         msg.includes('Malformed selector') ||
         msg.includes('Invalid selector') ||
         msg.includes('is not a valid selector');
}

export function isElementInteractionError(err) {
  const msg = err && err.message || '';
  return msg.includes('not visible') ||
         msg.includes('not an <input>') ||
         msg.includes('Element is outside of the viewport') ||
         msg.includes('element is not attached') ||
         msg.includes('Element is not attached') ||
         msg.includes('no bounding box') ||
         msg.includes('intercepts pointer events');
}

export function browserErrorStatus(err) {
  if (isTabDestroyedError(err) || isPageCrashedError(err)) return 410;
  if (isStaleRefsError(err) || isElementInteractionError(err)) return 422;
  if (isInvalidSelectorError(err)) return 400;
  if (isNavigationRaceError(err)) return 409;
  if (isDeadContextError(err) || isTabLockQueueTimeout(err) || isUserConcurrencyTimeout(err) || isBrowserLaunchError(err)) return 503;
  return err?.statusCode || null;
}

export function browserErrorCode(err) {
  if (isPageCrashedError(err)) return 'page_crashed';
  if (isTabDestroyedError(err)) return 'tab_destroyed';
  if (isStaleRefsError(err)) return 'stale_refs';
  if (isInvalidSelectorError(err)) return 'invalid_selector';
  if (isNavigationRaceError(err)) return 'navigation_race';
  if (isDeadContextError(err)) return 'session_expired';
  if (isTabLockQueueTimeout(err)) return 'tab_unresponsive';
  if (isUserConcurrencyTimeout(err)) return 'concurrency_timeout';
  if (isBrowserLaunchError(err)) return 'browser_launch_timeout';
  if (isElementInteractionError(err)) return 'element_not_actionable';
  return err?.code || null;
}

export function browserErrorRecovery(err) {
  const code = browserErrorCode(err);
  if (code === 'page_crashed' || code === 'tab_destroyed' || code === 'tab_unresponsive') return 'create_new_tab';
  if (code === 'stale_refs' || code === 'element_not_actionable' || code === 'navigation_race') return 'snapshot_then_retry';
  if (code === 'session_expired' || code === 'concurrency_timeout' || code === 'browser_launch_timeout') return 'retry';
  return null;
}

export function isRetryableBrowserError(err) {
  return Boolean(browserErrorRecovery(err));
}
