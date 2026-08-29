/**
 * Tests for navigation timeout session destruction.
 *
 * When a click/navigate/open_url times out, the proxy session may be poisoned
 * (e.g., Cloudflare holding the connection). The server should destroy the
 * entire user session so the next request gets a fresh BrowserContext + proxy.
 *
 * That teardown is conditional on there being a proxy to rotate. With no proxy
 * pool configured there is nothing to get fresh, and destroying the session
 * only costs every other tab under that userId.
 *
 * Non-navigation timeouts (type, scroll) should only track per-tab consecutive
 * timeouts without destroying the session.
 */

import { actionFromReq, classifyError } from '../../lib/request-utils.js';

// --- Replicate the error handling logic from server.js ---

const NAVIGATION_TIMEOUT_ACTIONS = new Set(['click', 'navigate', 'open_url']);
const MAX_CONSECUTIVE_TIMEOUTS = 3;

function isTimeoutError(err) {
  if (!err) return false;
  const msg = err.message || '';
  return msg.includes('timed out after') || (msg.includes('Timeout') && msg.includes('exceeded'));
}

function isProxyError(err) {
  if (!err) return false;
  const msg = err.message || '';
  return msg.includes('NS_ERROR_PROXY') || msg.includes('proxy connection') || msg.includes('Proxy connection');
}

/**
 * Simulate handleRouteError's session/tab destruction logic.
 *
 * canRotateSessions mirrors proxyPool?.canRotateSessions. It defaults to true so
 * the cases below read as "with a proxy configured", which is what the original
 * tests here assumed.
 *
 * Returns { sessionDestroyed, tabDestroyed, reason, navFailureRecorded }.
 */
function simulateErrorHandling(err, action, userId, tabState, canRotateSessions = true) {
  const result = { sessionDestroyed: false, tabDestroyed: false, reason: null, navFailureRecorded: false };

  // Proxy errors destroy session -- but only when there is a proxy to rotate to.
  if (isProxyError(err) && canRotateSessions && userId) {
    result.sessionDestroyed = true;
    result.reason = 'proxy_error';
    return result;
  }

  // Navigation timeouts destroy session (proxy may be poisoned)
  const isNavigationTimeout = isTimeoutError(err) && userId && NAVIGATION_TIMEOUT_ACTIONS.has(action);
  if (isNavigationTimeout && canRotateSessions) {
    result.sessionDestroyed = true;
    result.reason = 'navigation_timeout';
    result.navFailureRecorded = true;
    return result;
  }
  // No proxy to rotate: keep the health signal, spare everyone else's tabs.
  if (isNavigationTimeout) {
    result.navFailureRecorded = true;
    return result;
  }

  // Non-navigation timeouts track per-tab consecutive count
  if (isTimeoutError(err) && userId && !NAVIGATION_TIMEOUT_ACTIONS.has(action) && tabState) {
    tabState.consecutiveTimeouts = (tabState.consecutiveTimeouts || 0) + 1;
    if (tabState.consecutiveTimeouts >= MAX_CONSECUTIVE_TIMEOUTS) {
      result.tabDestroyed = true;
      result.reason = 'consecutive_timeouts';
    }
    return result;
  }

  return result;
}

// --- Tests ---

describe('navigation timeout session destruction', () => {
  const timeoutError = new Error('action timed out after 30000ms');
  const playwrightTimeout = new Error('page.goto: Timeout 30000ms exceeded.\nCall log:\n  - navigating to "https://www.google.com/", waiting until "domcontentloaded"');
  const proxyError = new Error('NS_ERROR_PROXY_CONNECTION_REFUSED');

  test('click timeout destroys session', () => {
    const result = simulateErrorHandling(timeoutError, 'click', 'user-1', {});
    expect(result.sessionDestroyed).toBe(true);
    expect(result.reason).toBe('navigation_timeout');
  });

  test('navigate timeout destroys session', () => {
    const result = simulateErrorHandling(playwrightTimeout, 'navigate', 'user-1', {});
    expect(result.sessionDestroyed).toBe(true);
    expect(result.reason).toBe('navigation_timeout');
  });

  test('open_url timeout destroys session', () => {
    const result = simulateErrorHandling(timeoutError, 'open_url', 'user-1', {});
    expect(result.sessionDestroyed).toBe(true);
    expect(result.reason).toBe('navigation_timeout');
  });

  test('type timeout does NOT destroy session, tracks per-tab', () => {
    const tabState = { consecutiveTimeouts: 0 };
    const result = simulateErrorHandling(timeoutError, 'type', 'user-1', tabState);
    expect(result.sessionDestroyed).toBe(false);
    expect(result.tabDestroyed).toBe(false);
    expect(tabState.consecutiveTimeouts).toBe(1);
  });

  test('scroll timeout does NOT destroy session', () => {
    const tabState = { consecutiveTimeouts: 0 };
    const result = simulateErrorHandling(timeoutError, 'scroll', 'user-1', tabState);
    expect(result.sessionDestroyed).toBe(false);
    expect(tabState.consecutiveTimeouts).toBe(1);
  });

  test('3 consecutive type timeouts destroys tab (not session)', () => {
    const tabState = { consecutiveTimeouts: 0 };
    simulateErrorHandling(timeoutError, 'type', 'user-1', tabState);
    simulateErrorHandling(timeoutError, 'type', 'user-1', tabState);
    const result = simulateErrorHandling(timeoutError, 'type', 'user-1', tabState);
    expect(result.tabDestroyed).toBe(true);
    expect(result.sessionDestroyed).toBe(false);
    expect(result.reason).toBe('consecutive_timeouts');
  });

  test('proxy error still destroys session', () => {
    const result = simulateErrorHandling(proxyError, 'navigate', 'user-1', {});
    expect(result.sessionDestroyed).toBe(true);
    expect(result.reason).toBe('proxy_error');
  });

  test('no userId = no destruction', () => {
    const result = simulateErrorHandling(timeoutError, 'click', null, {});
    expect(result.sessionDestroyed).toBe(false);
    expect(result.tabDestroyed).toBe(false);
  });

  test('non-timeout error on click does NOT destroy session', () => {
    const otherError = new Error('Element not found');
    const result = simulateErrorHandling(otherError, 'click', 'user-1', {});
    expect(result.sessionDestroyed).toBe(false);
  });
});

// Destroying the session is a proxy-rotation strategy. With no proxy pool there
// is nothing to rotate to, so the teardown buys nothing and costs every other
// tab under that userId -- including concurrent callers, who then get 404
// "Tab not found" (#8559).
describe('navigation timeout with no proxy to rotate', () => {
  const timeoutError = new Error('action timed out after 30000ms');
  const proxyError = new Error('NS_ERROR_PROXY_CONNECTION_REFUSED');

  test.each(['click', 'navigate', 'open_url'])(
    '%s timeout does NOT destroy the session when sessions cannot rotate',
    (action) => {
      const result = simulateErrorHandling(timeoutError, action, 'user-1', {}, false);
      expect(result.sessionDestroyed).toBe(false);
      expect(result.tabDestroyed).toBe(false);
    },
  );

  test('the navigation failure is still recorded when there is no proxy', () => {
    const result = simulateErrorHandling(timeoutError, 'navigate', 'user-1', {}, false);
    expect(result.navFailureRecorded).toBe(true);
  });

  test('the same timeout still destroys the session when a proxy can rotate', () => {
    const result = simulateErrorHandling(timeoutError, 'navigate', 'user-1', {}, true);
    expect(result.sessionDestroyed).toBe(true);
    expect(result.reason).toBe('navigation_timeout');
  });

  test('proxy errors also require a rotatable proxy', () => {
    const result = simulateErrorHandling(proxyError, 'navigate', 'user-1', {}, false);
    expect(result.sessionDestroyed).toBe(false);
  });

  test('non-navigation timeouts still track per-tab with no proxy', () => {
    const tabState = { consecutiveTimeouts: 0 };
    const result = simulateErrorHandling(timeoutError, 'type', 'user-1', tabState, false);
    expect(result.sessionDestroyed).toBe(false);
    expect(tabState.consecutiveTimeouts).toBe(1);
  });

  test('a stuck tab is still collected after 3 consecutive timeouts with no proxy', () => {
    const tabState = { consecutiveTimeouts: 0 };
    simulateErrorHandling(timeoutError, 'type', 'user-1', tabState, false);
    simulateErrorHandling(timeoutError, 'type', 'user-1', tabState, false);
    const result = simulateErrorHandling(timeoutError, 'type', 'user-1', tabState, false);
    expect(result.tabDestroyed).toBe(true);
    expect(result.sessionDestroyed).toBe(false);
  });
});

describe('actionFromReq classifies routes correctly', () => {
  function makeReq(method, routePath) {
    return { method, route: { path: routePath }, path: routePath };
  }

  test('click route → "click"', () => {
    expect(actionFromReq(makeReq('POST', '/tabs/:tabId/click'))).toBe('click');
  });

  test('navigate route → "navigate"', () => {
    expect(actionFromReq(makeReq('POST', '/tabs/:tabId/navigate'))).toBe('navigate');
  });

  test('open_url route → "open_url"', () => {
    expect(actionFromReq(makeReq('POST', '/tabs/open'))).toBe('open_url');
  });

  test('type route → "type"', () => {
    expect(actionFromReq(makeReq('POST', '/tabs/:tabId/type'))).toBe('type');
  });

  test('scroll route → "scroll"', () => {
    expect(actionFromReq(makeReq('POST', '/tabs/:tabId/scroll'))).toBe('scroll');
  });

  test('create_tab route → "create_tab"', () => {
    expect(actionFromReq(makeReq('POST', '/tabs'))).toBe('create_tab');
  });

  test('concrete tab action paths are normalized', () => {
    expect(actionFromReq({ method: 'POST', path: '/tabs/68341eecdd3168_abc-123/navigate' })).toBe('navigate');
    expect(actionFromReq({ method: 'GET', path: '/tabs/68341eecdd3168_abc-123/snapshot' })).toBe('snapshot');
  });

  test('concrete session paths are normalized', () => {
    expect(actionFromReq({ method: 'DELETE', path: '/sessions/17900' })).toBe('delete_session');
    expect(actionFromReq({ method: 'POST', path: '/sessions/17900/cookies' })).toBe('set_cookies');
  });
});

describe('classifyError categorizes timeout vs proxy', () => {
  test('action timeout → "timeout"', () => {
    expect(classifyError(new Error('action timed out after 30000ms'))).toBe('timeout');
  });

  test('playwright timeout → "timeout"', () => {
    expect(classifyError(new Error('page.goto: Timeout 30000ms exceeded.'))).toBe('timeout');
  });

  test('proxy refused → "proxy"', () => {
    expect(classifyError(new Error('NS_ERROR_PROXY_CONNECTION_REFUSED'))).toBe('proxy');
  });

  test('dead context → "dead_context"', () => {
    expect(classifyError(new Error('Target page, context or browser has been closed'))).toBe('dead_context');
  });

  test('operational browser failures classify without unknown', () => {
    expect(classifyError(Object.assign(new Error('Unknown ref: e999'), { code: 'stale_refs' }))).toBe('stale_refs');
    expect(classifyError(new Error('Execution context was destroyed, most likely because of a navigation'))).toBe('navigation_race');
    expect(classifyError(new Error('page.goto: NS_ERROR_NET_INTERRUPT'))).toBe('navigation_race');
    expect(classifyError(new Error('page.reload: NS_BINDING_ABORTED'))).toBe('navigation_race');
    expect(classifyError(new Error("locator.click: Error: strict mode violation: locator('td') resolved to 62 elements:"))).toBe('ambiguous_selector');
    expect(classifyError(new Error('locator.fill: Error: Malformed value'))).toBe('element_error');
    expect(classifyError(new Error('Element input[type=submit] is not fillable. Use click for buttons and other controls.'))).toBe('element_error');
    expect(classifyError(new Error('locator.fill: Unexpected token "[" while parsing selector "text=[broken"'))).toBe('invalid_selector');
    expect(classifyError(new Error('User concurrency limit reached, try again'))).toBe('concurrency_timeout');
    expect(classifyError(new Error('Browser launch timeout (60s)'))).toBe('browser_launch');
    expect(classifyError(new Error('Element is not attached to the DOM'))).toBe('element_error');
    expect(classifyError(new Error('Target crashed'))).toBe('page_crashed');
  });
});
