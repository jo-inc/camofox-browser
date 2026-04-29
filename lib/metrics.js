// Prometheus metrics for camofox-browser -- lazy-loaded, off by default.
// Enable with PROMETHEUS_ENABLED=1 in environment (read via config.js).
//
// RULE: This file must NOT contain words matching /process\.env/ or /\bpost\b/i.
// See AGENTS.md "Code Separation Conventions" for details.

let _metrics = null;
let _register = null;

// No-op stubs when prometheus is disabled.
const noopCounter = { inc() {}, labels() { return this; } };
const noopHistogram = { observe() {}, startTimer() { return () => {}; }, labels() { return this; } };
const noopGauge = { set() {}, inc() {}, dec() {}, labels() { return this; } };

/**
 * Create a metric (Counter, Histogram, or Gauge) registered to the shared registry.
 * Returns a no-op stub when Prometheus is disabled -- plugins never need to check.
 *
 * @param {'counter'|'histogram'|'gauge'} type
 * @param {object} opts - prom-client options: { name, help, labelNames, buckets, ... }
 * @returns {object} The metric instance or a no-op stub
 */
export async function createMetric(type, opts) {
  if (!_register) {
    if (type === 'histogram') return noopHistogram;
    if (type === 'gauge') return noopGauge;
    return noopCounter;
  }
  const client = (await import('prom-client')).default;
  const MetricClass = type === 'histogram' ? client.Histogram
    : type === 'gauge' ? client.Gauge
    : client.Counter;
  return new MetricClass({ ...opts, registers: [_register] });
}

function buildNoopMetrics() {
  return {
    requestsTotal: noopCounter,
    tabLockTimeoutsTotal: noopCounter,
    failuresTotal: noopCounter,
    browserRestartsTotal: noopCounter,
    tabsDestroyedTotal: noopCounter,
    sessionsExpiredTotal: noopCounter,
    tabsReapedTotal: noopCounter,
    tabsRecycledTotal: noopCounter,
    requestDuration: noopHistogram,
    pageLoadDuration: noopHistogram,
    snapshotBytes: noopHistogram,
    activeTabsGauge: noopGauge,
    tabLockQueueDepth: noopGauge,
    memoryUsageBytes: noopGauge,
  };
}

async function buildRealMetrics() {
  const client = (await import('prom-client')).default;
  _register = new client.Registry();
  client.collectDefaultMetrics({ register: _register });

  return {
    requestsTotal: new client.Counter({
      name: 'camofox_requests_total',
      help: 'Total HTTP requests by action and status',
      labelNames: ['action', 'status'],
      registers: [_register],
    }),
    tabLockTimeoutsTotal: new client.Counter({
      name: 'camofox_tab_lock_timeouts_total',
      help: 'Tab lock queue timeouts resulting in 503',
      registers: [_register],
    }),
    failuresTotal: new client.Counter({
      name: 'camofox_failures_total',
      help: 'Total failures by type and action',
      labelNames: ['type', 'action'],
      registers: [_register],
    }),
    browserRestartsTotal: new client.Counter({
      name: 'camofox_restarts_total',
      help: 'Browser restarts by reason',
      labelNames: ['reason'],
      registers: [_register],
    }),
    tabsDestroyedTotal: new client.Counter({
      name: 'camofox_tabs_destroyed_total',
      help: 'Tabs force-destroyed by reason',
      labelNames: ['reason'],
      registers: [_register],
    }),
    sessionsExpiredTotal: new client.Counter({
      name: 'camofox_sessions_expired_total',
      help: 'Sessions expired due to inactivity',
      registers: [_register],
    }),
    tabsReapedTotal: new client.Counter({
      name: 'camofox_tabs_reaped_total',
      help: 'Tabs reaped due to inactivity',
      registers: [_register],
    }),
    tabsRecycledTotal: new client.Counter({
      name: 'camofox_tabs_recycled_total',
      help: 'Tabs recycled when tab limit reached',
      registers: [_register],
    }),
    requestDuration: new client.Histogram({
      name: 'camofox_request_duration_seconds',
      help: 'Request duration in seconds by action',
      labelNames: ['action'],
      buckets: [0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60],
      registers: [_register],
    }),
    pageLoadDuration: new client.Histogram({
      name: 'camofox_page_load_duration_seconds',
      help: 'Page load duration in seconds',
      buckets: [0.5, 1, 2, 5, 10, 20, 30, 60],
      registers: [_register],
    }),
    snapshotBytes: new client.Histogram({
      name: 'camofox_snapshot_bytes',
      help: 'Size of accessibility tree snapshots in bytes (before windowing)',
      labelNames: ['type'],
      buckets: [1000, 5000, 10000, 25000, 50000, 80000, 120000, 200000, 500000],
      registers: [_register],
    }),
    activeTabsGauge: new client.Gauge({
      name: 'camofox_active_tabs',
      help: 'Current number of open browser tabs',
      registers: [_register],
    }),
    tabLockQueueDepth: new client.Gauge({
      name: 'camofox_tab_lock_queue_depth',
      help: 'Current number of requests waiting for a tab lock',
      registers: [_register],
    }),
    memoryUsageBytes: new client.Gauge({
      name: 'camofox_memory_usage_bytes',
      help: 'RSS memory usage in bytes',
      registers: [_register],
    }),
  };
}

/**
 * Initialize metrics. Pass `enabled: true` (from config.prometheusEnabled)
 * to load prom-client; otherwise returns no-op stubs.
 */
export async function initMetrics({ enabled = false } = {}) {
  if (_metrics) return _metrics;
  _metrics = enabled ? await buildRealMetrics() : buildNoopMetrics();
  return _metrics;
}

/** Get the initialized metrics object. Throws if initMetrics() hasn't been called. */
export function getMetrics() {
  if (!_metrics) throw new Error('Metrics not initialized -- call initMetrics() first');
  return _metrics;
}

/** Get the Prometheus registry, or null if disabled. */
export function getRegister() {
  return _register;
}

/** Whether prometheus is actually running (not no-op). */
export function isMetricsEnabled() {
  return _register !== null;
}

// Periodic memory reporter
const MEMORY_INTERVAL_MS = 30_000;
let memoryTimer = null;

export function startMemoryReporter() {
  if (memoryTimer || !isMetricsEnabled()) return;
  const m = getMetrics();
  const report = () => m.memoryUsageBytes.set(globalThis.process.memoryUsage().rss);
  report();
  memoryTimer = setInterval(report, MEMORY_INTERVAL_MS);
  memoryTimer.unref();
}

export function stopMemoryReporter() {
  if (memoryTimer) { clearInterval(memoryTimer); memoryTimer = null; }
}
