// HTTP request classification helpers -- kept separate from metrics.js
// Separated from server.js to keep HTTP method classification in its own module.

/**
 * Derive a short action name from an Express request for metrics labeling.
 */
export function actionFromReq(req) {
  const method = req.method;
  const routePath = req.route?.path;
  const path = routePath || req.path || '';
  if (path === '/tabs' && method === 'POST') return 'create_tab';
  if (path === '/tabs/:tabId' && method === 'DELETE') return 'delete_tab';
  if (path === '/tabs/group/:listItemId' && method === 'DELETE') return 'delete_tab_group';
  if (path === '/sessions/:userId' && method === 'DELETE') return 'delete_session';
  if (path === '/sessions/:userId/cookies' && method === 'POST') return 'set_cookies';
  if (path === '/tabs/open' && method === 'POST') return 'open_url';
  if (path === '/tabs' && method === 'GET') return 'list_tabs';

  const tabAction = path.match(/^\/tabs\/(?:[^/]+|:tabId)\/(\w+)$/);
  if (tabAction) return tabAction[1];

  if (path.match(/^\/tabs\/(?:[^/]+|:tabId)$/) && method === 'DELETE') return 'delete_tab';
  if (path.match(/^\/tabs\/group\/(?:[^/]+|:listItemId)$/) && method === 'DELETE') return 'delete_tab_group';
  if (path.match(/^\/sessions\/(?:[^/]+|:userId)$/) && method === 'DELETE') return 'delete_session';
  if (path.match(/^\/sessions\/(?:[^/]+|:userId)\/cookies$/) && method === 'POST') return 'set_cookies';

  // legacy compat routes
  if (['/start', '/stop', '/navigate', '/snapshot', '/act'].includes(path)) return path.slice(1);
  if (path === '/youtube/transcript') return 'youtube_transcript';
  if (path === '/health') return 'health';
  if (path === '/metrics') return 'metrics';
  return `${method.toLowerCase()}_${path.replace(/[/:]/g, '_').replace(/_+/g, '_').replace(/^_|_$/g, '')}`;
}

/**
 * Classify an error into a failure type string for metrics labeling.
 */
export function classifyError(err) {
  if (!err) return 'unknown';
  const msg = err.message || '';

  if (err.code === 'stale_refs' || err.name === 'StaleRefsError') return 'stale_refs';
  if (err.code === 'invalid_selector' ||
      (msg.includes('Unexpected token') && msg.includes('selector')) ||
      (msg.includes('Unsupported token') && msg.includes('selector')) ||
      msg.includes('Malformed selector') || msg.includes('Invalid selector') ||
      msg.includes('is not a valid selector')) return 'invalid_selector';
  if (msg === 'Tab lock queue timeout') return 'tab_lock_timeout';
  if (msg === 'Tab destroyed') return 'tab_destroyed';
  if (msg.includes('Target page, context or browser has been closed') ||
      msg.includes('browser has been closed') ||
      msg.includes('Context closed') ||
      msg.includes('Browser closed')) return 'dead_context';
  if (msg.includes('timed out after') ||
      (msg.includes('Timeout') && msg.includes('exceeded'))) return 'timeout';
  if (msg.includes('Maximum concurrent sessions')) return 'session_limit';
  if (msg.includes('Maximum tabs per session') || msg.includes('Maximum global tabs')) return 'tab_limit';
  if (msg.includes('User concurrency limit reached') || msg.includes('concurrency limit reached')) return 'concurrency_timeout';
  if (msg.includes('NS_ERROR_PROXY') || msg.includes('proxy connection') ||
      msg.includes('Proxy connection')) return 'proxy';
  if (msg.includes('Browser launch timeout') || msg.includes('Failed to launch')) return 'browser_launch';
  if (msg.includes('intercepts pointer events')) return 'element_error';
  if (msg.includes('not visible') || msg.includes('not an <input>') ||
      msg.includes('element is not attached') || msg.includes('Element is not attached') ||
      msg.includes('no bounding box')) return 'element_error';
  if (msg.includes('Blocked URL scheme') || msg.includes('Invalid URL')) return 'invalid_url';
  if (msg.includes('net::') || msg.includes('ERR_NAME') || msg.includes('ERR_CONNECTION')) return 'network';
  if (msg.includes('Navigation aborted: tab deleted')) return 'tab_destroyed';
  if (msg.includes('Execution context was destroyed') ||
      msg.includes('Cannot find context with specified id') ||
      msg.includes('Frame was detached') ||
      msg.includes('Navigation interrupted')) return 'navigation_race';
  if (msg.includes('NS_ERROR_ABORT')) return 'nav_aborted';
  if (msg.includes('Page crashed') || msg.includes('Target crashed') || msg.includes('crashed page')) return 'page_crashed';
  if (msg.includes('Navigation failed') || msg.includes('ERR_ABORTED')) return 'nav_aborted';
  return 'unknown';
}
