// lib/resources.js -- Process resource metrics and proxy error classification.
// Isolated from reporter.js so that fs reads and network sends are never
// in the same file (keeps fs reads and network sends in separate modules).

import fs from 'fs';

// ============================================================================
// Process resource snapshot (memory, handles, FDs, browser RSS)
// ============================================================================

/**
 * Collect process-level resource metrics. Safe to call at any time.
 * Returns anonymized metrics -- no PIDs, paths, or user data.
 */
export function collectResourceSnapshot(opts = {}) {
  const mem = process.memoryUsage();
  const snap = {
    nodeRssMb: Math.round(mem.rss / 1048576),
    nodeHeapUsedMb: Math.round(mem.heapUsed / 1048576),
    nodeHeapTotalMb: Math.round(mem.heapTotal / 1048576),
    nodeExternalMb: Math.round(mem.external / 1048576),
    eventLoopLagMs: null,
    activeHandles: null,
    activeRequests: null,
    openFds: null,
    browserRssMb: null,
  };

  // Active libuv handles/requests (private API, guarded)
  try { snap.activeHandles = process._getActiveHandles().length; } catch { /* unavailable */ }
  try { snap.activeRequests = process._getActiveRequests().length; } catch { /* unavailable */ }

  // Open file descriptors (Linux only)
  try {
    if (process.platform === 'linux') {
      snap.openFds = fs.readdirSync('/proc/self/fd').length;
    }
  } catch { /* not available or permission denied */ }

  // Browser process RSS (the one people miss -- browser OOMs, not Node)
  if (opts.browserPid && Number.isInteger(opts.browserPid) && opts.browserPid > 0) {
    try {
      if (process.platform === 'linux') {
        const status = fs.readFileSync(`/proc/${opts.browserPid}/status`, 'utf8');
        const match = status.match(/VmRSS:\s+(\d+)\s+kB/);
        if (match) snap.browserRssMb = Math.round(parseInt(match[1], 10) / 1024);
      }
    } catch { /* process gone or permission denied */ }
  }

  // Session/tab counts from caller
  if (opts.sessionCount != null) snap.browserContexts = opts.sessionCount;
  if (opts.tabCount != null) snap.activeTabs = opts.tabCount;

  return snap;
}

// ============================================================================
// Proxy error classification
// ============================================================================

/**
 * Classify proxy errors from Playwright navigation error messages.
 * Returns { proxyError: string|null, proxyTlsError: bool } -- no IPs or credentials.
 */
export function classifyProxyError(errorMessage) {
  if (!errorMessage || typeof errorMessage !== 'string') return { proxyError: null, proxyTlsError: false };
  const msg = errorMessage.toUpperCase();
  if (msg.includes('ERR_PROXY_CONNECTION_FAILED')) return { proxyError: 'ERR_PROXY_CONNECTION_FAILED', proxyTlsError: false };
  if (msg.includes('ERR_TUNNEL_CONNECTION_FAILED')) return { proxyError: 'ERR_TUNNEL_CONNECTION_FAILED', proxyTlsError: false };
  if (msg.includes('ERR_PROXY_AUTH_REQUESTED') || msg.includes('407')) return { proxyError: 'ERR_PROXY_AUTH_REQUESTED', proxyTlsError: false };
  if (msg.includes('ERR_PROXY_CERTIFICATE_INVALID') || (msg.includes('PROXY') && msg.includes('SSL'))) return { proxyError: 'ERR_PROXY_TLS', proxyTlsError: true };
  if (msg.includes('ECONNREFUSED') && msg.includes('PROXY')) return { proxyError: 'ECONNREFUSED', proxyTlsError: false };
  if (msg.includes('ETIMEDOUT') && msg.includes('PROXY')) return { proxyError: 'ETIMEDOUT', proxyTlsError: false };
  return { proxyError: null, proxyTlsError: false };
}
