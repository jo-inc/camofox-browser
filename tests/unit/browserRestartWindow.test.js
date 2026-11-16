'use strict';

/**
 * Reliability tests for the long-running persistence fixes:
 *  1. The 410 "browser_restarted" window (BROWSER_RESTARTED_WINDOW_MS) must be
 *     wide enough that a client which pauses for several minutes after a
 *     browser restart still gets 410 (not a plain 404) so it can recreate the
 *     tab — but not so wide that an ancient tab ID masquerades as "restarted".
 *  2. The inactivity reaper must reap a *crashed* tab after a short quiet
 *     period instead of waiting out the full TAB_INACTIVITY_MS, so a leaked
 *     content-process slot is released promptly.
 *
 * The decision logic is replicated here as pure functions (the established
 * pattern in this repo, cf. memoryPressure.test.js) so we can test thresholds
 * without a running browser.
 */

// Mirrors the constant + comparison in server.js tabNotFoundResponse.
const BROWSER_RESTARTED_WINDOW_MS = 30 * 60_000;

function isWithinRestartedWindow(lastBrowserRestartAt, now) {
  return !!lastBrowserRestartAt && (now - lastBrowserRestartAt < BROWSER_RESTARTED_WINDOW_MS);
}

describe('410 browser_restarted window', () => {
  const now = 1_000_000_000;

  test('freshly restarted browser (1s ago) is within the window', () => {
    expect(isWithinRestartedWindow(now - 1_000, now)).toBe(true);
  });

  test('a client returning 6 minutes after a restart is still within the window', () => {
    // This is the regression that bit long-running agent work: the window used
    // to be 5 minutes, so a 6-minute pause turned a 410 into a 404.
    expect(isWithinRestartedWindow(now - 6 * 60_000, now)).toBe(true);
  });

  test('a client returning 30 minutes after a restart is still within the window', () => {
    // Boundary: the comparison is strict `<`, so exactly at the window edge it
    // flips to false. 29 min 59 s is still in.
    expect(isWithinRestartedWindow(now - (30 * 60_000 - 1_000), now)).toBe(true);
  });

  test('an ancient tab (31 minutes after restart) falls outside the window', () => {
    expect(isWithinRestartedWindow(now - 31 * 60_000, now)).toBe(false);
  });

  test('no recorded restart (never launched) is outside the window', () => {
    expect(isWithinRestartedWindow(null, now)).toBe(false);
  });
});

// Mirrors the per-tab inactivity reaper decision in server.js.
function shouldReapTab(tabState, idleMs, TAB_INACTIVITY_MS = 300_000) {
  const quiet = tabState.toolCalls === tabState._lastReaperToolCalls;
  if (!quiet) return false;
  const reapAfterMs = tabState.crashed ? Math.min(60_000, TAB_INACTIVITY_MS) : TAB_INACTIVITY_MS;
  return idleMs >= reapAfterMs;
}

describe('crashed-tab inactivity reaper', () => {
  test('a healthy idle tab is not reaped before TAB_INACTIVITY_MS', () => {
    const tab = { toolCalls: 3, _lastReaperToolCalls: 3, crashed: false };
    expect(shouldReapTab(tab, 299_000, 300_000)).toBe(false);
  });

  test('a healthy idle tab is reaped at TAB_INACTIVITY_MS', () => {
    const tab = { toolCalls: 3, _lastReaperToolCalls: 3, crashed: false };
    expect(shouldReapTab(tab, 300_000, 300_000)).toBe(true);
  });

  test('a crashed tab is reaped after only 60s of quiet, far earlier than the healthy threshold', () => {
    const tab = { toolCalls: 3, _lastReaperToolCalls: 3, crashed: true };
    expect(shouldReapTab(tab, 59_000, 300_000)).toBe(false);
    expect(shouldReapTab(tab, 60_000, 300_000)).toBe(true);
  });

  test('a crashed tab that is still receiving calls is not reaped yet', () => {
    const tab = { toolCalls: 5, _lastReaperToolCalls: 3, crashed: true };
    expect(shouldReapTab(tab, 300_000, 300_000)).toBe(false);
  });

  test('when TAB_INACTIVITY_MS is configured below 60s, crashed tabs respect the configured value', () => {
    // Math.min(60_000, TAB_INACTIVITY_MS) → the smaller (configured) value wins.
    const tab = { toolCalls: 3, _lastReaperToolCalls: 3, crashed: true };
    expect(shouldReapTab(tab, 29_000, 30_000)).toBe(false);
    expect(shouldReapTab(tab, 30_000, 30_000)).toBe(true);
  });
});
