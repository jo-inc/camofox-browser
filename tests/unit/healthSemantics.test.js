'use strict';

/**
 * Tests for /health endpoint semantics:
 * - 200 when browser running
 * - 200 when browser intentionally idle-stopped (idle_shutdown, admin_stop)
 * - 503 when browser unexpectedly missing (browser_disconnected, memory_pressure, etc.)
 */

const INTENTIONAL_STOP_REASONS = new Set(['idle_shutdown', 'admin_stop']);

function computeHealthResponse({ browserConnected, lastStopReason, isRecovering }) {
  if (isRecovering) {
    return { status: 503, body: { ok: false, recovering: true } };
  }
  if (!browserConnected && lastStopReason && !INTENTIONAL_STOP_REASONS.has(lastStopReason)) {
    return { status: 503, body: { ok: false, browserRunning: false, reason: lastStopReason } };
  }
  return { status: 200, body: { ok: true, browserRunning: browserConnected } };
}

describe('health endpoint semantics', () => {
  test('returns 200 when browser is connected', () => {
    const r = computeHealthResponse({ browserConnected: true, lastStopReason: null, isRecovering: false });
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);
  });

  test('returns 200 when browser idle-stopped intentionally', () => {
    const r = computeHealthResponse({ browserConnected: false, lastStopReason: 'idle_shutdown', isRecovering: false });
    expect(r.status).toBe(200);
  });

  test('returns 200 when browser admin-stopped', () => {
    const r = computeHealthResponse({ browserConnected: false, lastStopReason: 'admin_stop', isRecovering: false });
    expect(r.status).toBe(200);
  });

  test('returns 503 when browser disconnected unexpectedly', () => {
    const r = computeHealthResponse({ browserConnected: false, lastStopReason: 'browser_disconnected', isRecovering: false });
    expect(r.status).toBe(503);
    expect(r.body.reason).toBe('browser_disconnected');
  });

  test('returns 503 for memory_pressure', () => {
    const r = computeHealthResponse({ browserConnected: false, lastStopReason: 'memory_pressure', isRecovering: false });
    expect(r.status).toBe(503);
  });

  test('returns 503 for browser_rss_pressure', () => {
    const r = computeHealthResponse({ browserConnected: false, lastStopReason: 'browser_rss_pressure', isRecovering: false });
    expect(r.status).toBe(503);
  });

  test('returns 503 when recovering', () => {
    const r = computeHealthResponse({ browserConnected: false, lastStopReason: 'idle_shutdown', isRecovering: true });
    expect(r.status).toBe(503);
    expect(r.body.recovering).toBe(true);
  });

  test('returns 200 when no stop reason (fresh start, browser not yet launched)', () => {
    const r = computeHealthResponse({ browserConnected: false, lastStopReason: null, isRecovering: false });
    expect(r.status).toBe(200);
  });

  test('returns 503 for browser_restart reasons', () => {
    const r = computeHealthResponse({ browserConnected: false, lastStopReason: 'browser_restart:nav_failures', isRecovering: false });
    expect(r.status).toBe(503);
  });
});
