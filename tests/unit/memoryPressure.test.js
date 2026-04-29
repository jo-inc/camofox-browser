/**
 * Tests for native memory pressure browser restart logic (#1032).
 *
 * The core decision logic from server.js is replicated here as a pure function
 * to verify threshold checks, baseline tracking, and edge cases without
 * needing a running browser.
 */

// ============================================================================
// Pure decision function (mirrors the setInterval logic in server.js)
// ============================================================================

/**
 * Evaluate whether the browser should be restarted due to native memory pressure.
 *
 * @param {object} state - Mutable state object: { baseline, sessionsSize, browserAlive }
 * @param {number} rssMb - Current RSS in MB
 * @param {number} heapUsedMb - Current JS heap used in MB
 * @param {number} thresholdMb - Growth threshold in MB
 * @returns {'skip'|'baseline_set'|'ok'|'restart'} action to take
 */
function evaluateMemoryPressure(state, rssMb, heapUsedMb, thresholdMb) {
  if (state.sessionsSize > 0 || !state.browserAlive) return 'skip';
  const nativeMemMb = Math.round(rssMb - heapUsedMb);
  if (state.baseline === null) {
    state.baseline = nativeMemMb;
    return 'baseline_set';
  }
  const growth = nativeMemMb - state.baseline;
  if (growth >= thresholdMb) return 'restart';
  return 'ok';
}

// ============================================================================
// Config parsing tests (mirrors the parseInt(env) || 200 pattern in config.js)
// ============================================================================

describe('NATIVE_MEM_RESTART_THRESHOLD_MB config parsing', () => {
  // Replicate the exact parsing expression from lib/config.js line 74:
  //   nativeMemRestartThresholdMb: parseInt(process.env.NATIVE_MEM_RESTART_THRESHOLD_MB) || 200
  function parseThreshold(envValue) {
    return parseInt(envValue) || 200;
  }

  test('defaults to 200 when env var is undefined', () => {
    expect(parseThreshold(undefined)).toBe(200);
  });

  test('defaults to 200 when env var is empty string', () => {
    expect(parseThreshold('')).toBe(200);
  });

  test('reads numeric string', () => {
    expect(parseThreshold('500')).toBe(500);
  });

  test('reads small value', () => {
    expect(parseThreshold('50')).toBe(50);
  });

  test('falls back to 200 on non-numeric value', () => {
    expect(parseThreshold('abc')).toBe(200);
  });

  test('falls back to 200 on zero (0 is falsy)', () => {
    // parseInt('0') === 0 which is falsy, so || 200 kicks in.
    // This is expected behavior — 0 threshold makes no sense.
    expect(parseThreshold('0')).toBe(200);
  });

  test('reads negative value (parseInt parses it)', () => {
    // parseInt('-100') === -100 which is truthy
    // Negative threshold means restart immediately — not useful but not broken.
    expect(parseThreshold('-100')).toBe(-100);
  });
});

// ============================================================================
// Memory pressure decision logic
// ============================================================================

describe('evaluateMemoryPressure', () => {
  test('skips when sessions are active', () => {
    const state = { baseline: null, sessionsSize: 3, browserAlive: true };
    expect(evaluateMemoryPressure(state, 500, 100, 200)).toBe('skip');
    expect(state.baseline).toBeNull(); // baseline not touched
  });

  test('skips when browser is not alive', () => {
    const state = { baseline: null, sessionsSize: 0, browserAlive: false };
    expect(evaluateMemoryPressure(state, 500, 100, 200)).toBe('skip');
    expect(state.baseline).toBeNull();
  });

  test('skips when sessions active AND browser dead', () => {
    const state = { baseline: null, sessionsSize: 1, browserAlive: false };
    expect(evaluateMemoryPressure(state, 500, 100, 200)).toBe('skip');
  });

  test('sets baseline on first idle check', () => {
    const state = { baseline: null, sessionsSize: 0, browserAlive: true };
    const result = evaluateMemoryPressure(state, 250, 100, 200);
    expect(result).toBe('baseline_set');
    expect(state.baseline).toBe(150); // 250 - 100
  });

  test('returns ok when growth is below threshold', () => {
    const state = { baseline: 150, sessionsSize: 0, browserAlive: true };
    // native = 300 - 100 = 200, growth = 200 - 150 = 50 < 200
    expect(evaluateMemoryPressure(state, 300, 100, 200)).toBe('ok');
  });

  test('returns ok when growth equals threshold minus one', () => {
    const state = { baseline: 150, sessionsSize: 0, browserAlive: true };
    // native = 449 - 100 = 349, growth = 349 - 150 = 199 < 200
    expect(evaluateMemoryPressure(state, 449, 100, 200)).toBe('ok');
  });

  test('returns restart when growth equals threshold exactly', () => {
    const state = { baseline: 150, sessionsSize: 0, browserAlive: true };
    // native = 450 - 100 = 350, growth = 350 - 150 = 200 >= 200
    expect(evaluateMemoryPressure(state, 450, 100, 200)).toBe('restart');
  });

  test('returns restart when growth exceeds threshold', () => {
    const state = { baseline: 147, sessionsSize: 0, browserAlive: true };
    // Exact scenario from #1032: baseline 147, current 453
    // native = 514 - 61 = 453, growth = 453 - 147 = 306 >= 200
    expect(evaluateMemoryPressure(state, 514, 61, 200)).toBe('restart');
  });

  test('respects custom threshold', () => {
    const state = { baseline: 100, sessionsSize: 0, browserAlive: true };
    // native = 400 - 50 = 350, growth = 350 - 100 = 250
    expect(evaluateMemoryPressure(state, 400, 50, 300)).toBe('ok');  // 250 < 300
    expect(evaluateMemoryPressure(state, 450, 50, 300)).toBe('restart'); // 300 >= 300
  });

  test('handles zero baseline', () => {
    const state = { baseline: 0, sessionsSize: 0, browserAlive: true };
    // native = 250 - 50 = 200, growth = 200 - 0 = 200 >= 200
    expect(evaluateMemoryPressure(state, 250, 50, 200)).toBe('restart');
  });

  test('handles negative growth (memory decreased)', () => {
    const state = { baseline: 300, sessionsSize: 0, browserAlive: true };
    // native = 250 - 50 = 200, growth = 200 - 300 = -100
    expect(evaluateMemoryPressure(state, 250, 50, 200)).toBe('ok');
  });
});

// ============================================================================
// Baseline lifecycle
// ============================================================================

describe('baseline lifecycle', () => {
  test('baseline resets to null and reestablishes on next check', () => {
    const state = { baseline: null, sessionsSize: 0, browserAlive: true };

    // First check: baseline set
    evaluateMemoryPressure(state, 250, 100, 200);
    expect(state.baseline).toBe(150);

    // Simulate browser close (reset)
    state.baseline = null;

    // Next check: new baseline established
    evaluateMemoryPressure(state, 200, 80, 200);
    expect(state.baseline).toBe(120);
  });

  test('does not update baseline on subsequent checks', () => {
    const state = { baseline: null, sessionsSize: 0, browserAlive: true };

    evaluateMemoryPressure(state, 250, 100, 200);
    expect(state.baseline).toBe(150);

    // Second check with different values — baseline should NOT change
    evaluateMemoryPressure(state, 300, 100, 200);
    expect(state.baseline).toBe(150); // unchanged
  });

  test('full churn cycle: baseline → growth → restart → new baseline', () => {
    const state = { baseline: null, sessionsSize: 0, browserAlive: true };

    // 1. Browser launches, first idle check sets baseline
    expect(evaluateMemoryPressure(state, 250, 100, 200)).toBe('baseline_set');
    expect(state.baseline).toBe(150);

    // 2. Sessions come and go, sessions back to 0, memory grew
    expect(evaluateMemoryPressure(state, 400, 100, 200)).toBe('ok'); // +150, under 200

    // 3. More churn, memory keeps growing
    expect(evaluateMemoryPressure(state, 500, 100, 200)).toBe('restart'); // +250, over 200

    // 4. Browser killed, baseline resets
    state.baseline = null;
    state.browserAlive = false;

    // 5. No browser — skip
    expect(evaluateMemoryPressure(state, 200, 80, 200)).toBe('skip');

    // 6. New browser launched on next request
    state.browserAlive = true;
    expect(evaluateMemoryPressure(state, 200, 80, 200)).toBe('baseline_set');
    expect(state.baseline).toBe(120);
  });

  test('sessions becoming active prevents restart even at high memory', () => {
    const state = { baseline: 100, sessionsSize: 0, browserAlive: true };

    // Memory is over threshold
    expect(evaluateMemoryPressure(state, 500, 50, 200)).toBe('restart');

    // But if a session arrives before the interval fires, it skips
    state.sessionsSize = 1;
    expect(evaluateMemoryPressure(state, 500, 50, 200)).toBe('skip');
  });
});
