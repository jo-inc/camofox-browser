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
function readVmRssKb(pid) {
  const status = fs.readFileSync(`/proc/${pid}/status`, 'utf8');
  const match = status.match(/VmRSS:\s+(\d+)\s+kB/);
  return match ? parseInt(match[1], 10) : 0;
}

function readChildPids(pid) {
  const childrenPath = `/proc/${pid}/task/${pid}/children`;
  const raw = fs.readFileSync(childrenPath, 'utf8').trim();
  if (!raw) return [];
  return raw.split(/\s+/).map((child) => parseInt(child, 10)).filter(Number.isInteger);
}

/**
 * Sum RSS for a browser process tree. This intentionally includes child content
 * processes because Firefox/Camoufox memory pressure mostly lives outside Node.
 */
export function browserProcessTreeRssMb(browserPid) {
  if (process.platform !== 'linux') return null;
  if (!browserPid || !Number.isInteger(browserPid) || browserPid <= 0) return null;

  const seen = new Set();
  let totalKb = 0;
  const stack = [browserPid];
  let foundRoot = false;

  while (stack.length > 0) {
    const pid = stack.pop();
    if (seen.has(pid)) continue;
    seen.add(pid);
    try {
      totalKb += readVmRssKb(pid);
      if (pid === browserPid) foundRoot = true;
      stack.push(...readChildPids(pid));
    } catch {
      // Process exited or /proc access failed; skip it.
    }
  }

  if (!foundRoot) return null;
  return Math.round(totalKb / 1024);
}

const BROWSER_PROCESS_NAMES = new Set([
  'camoufox-bin',
  'firefox',
  'Web Content',
  'WebExtensions',
  'Socket Process',
  'Utility Process',
  'RDD Process',
  'Privileged Cont',
]);

function readProcessName(pid) {
  const comm = fs.readFileSync(`/proc/${pid}/comm`, 'utf8').trim();
  if (comm) return comm;
  return '';
}

/**
 * Fallback browser RSS scanner for Camoufox/Firefox. Playwright's browser.process()
 * can be unavailable depending on the launcher path, but the process names are
 * still visible in /proc inside the Fly machine.
 */
export function browserProcessNameRssMb() {
  if (process.platform !== 'linux') return null;
  let totalKb = 0;
  let found = false;

  for (const pid of fs.readdirSync('/proc')) {
    if (!/^\d+$/.test(pid)) continue;
    try {
      const name = readProcessName(pid);
      if (!BROWSER_PROCESS_NAMES.has(name)) continue;
      totalKb += readVmRssKb(pid);
      found = true;
    } catch {
      // Process exited or /proc access failed; skip it.
    }
  }

  return found ? Math.round(totalKb / 1024) : null;
}

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
  snap.browserRssMb = browserProcessTreeRssMb(opts.browserPid);

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
