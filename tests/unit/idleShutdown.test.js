/**
 * Regression tests for idle browser shutdown scheduling.
 *
 * The cleanup intervals call scheduleBrowserIdleShutdown() repeatedly while the
 * server is idle. The scheduler must be idempotent; otherwise each interval
 * clears and recreates the timer, so the browser never shuts down.
 */

function createIdleShutdownScheduler({ getSessionsSize, hasBrowser, closeBrowser, setTimeoutFn, clearTimeoutFn }) {
  let browserIdleTimer = null;

  function scheduleBrowserIdleShutdown(timeoutMs) {
    if (browserIdleTimer || getSessionsSize() > 0 || !hasBrowser()) return;
    browserIdleTimer = setTimeoutFn(async () => {
      browserIdleTimer = null;
      if (getSessionsSize() === 0 && hasBrowser()) {
        await closeBrowser('idle_shutdown');
      }
    }, timeoutMs);
  }

  function clearBrowserIdleTimer() {
    if (browserIdleTimer) {
      clearTimeoutFn(browserIdleTimer);
      browserIdleTimer = null;
    }
  }

  return { scheduleBrowserIdleShutdown, clearBrowserIdleTimer, get hasTimer() { return !!browserIdleTimer; } };
}

function evaluateHealth({ isRecovering, browserRunning, warming, machineId }) {
  if (isRecovering) {
    return { status: 503, body: { ok: false, engine: 'camoufox', recovering: true } };
  }
  return {
    status: 200,
    body: {
      ok: true,
      engine: 'camoufox',
      browserConnected: browserRunning,
      browserRunning,
      ...(warming ? { warming: true } : {}),
      ...(machineId ? { machineId } : {}),
    },
  };
}

function shouldRunActiveHealthProbe({ hasBrowser, isRecovering, sessionsSize, activeOps, timeSinceSuccessMs }) {
  if (!hasBrowser || isRecovering) return false;
  if (sessionsSize === 0) return false;
  if (activeOps > 0 && timeSinceSuccessMs < 120000) return false;
  return timeSinceSuccessMs >= 120000;
}

describe('idle browser shutdown scheduler', () => {
  test('repeated idle cleanup ticks do not reset the existing shutdown timer', () => {
    let sessionsSize = 0;
    let browserAlive = true;
    let nextTimerId = 1;
    const timers = new Map();
    const cleared = [];
    const closed = [];

    const scheduler = createIdleShutdownScheduler({
      getSessionsSize: () => sessionsSize,
      hasBrowser: () => browserAlive,
      closeBrowser: (reason) => { closed.push(reason); browserAlive = false; },
      setTimeoutFn: (fn, ms) => {
        const id = nextTimerId++;
        timers.set(id, { fn, ms });
        return id;
      },
      clearTimeoutFn: (id) => {
        cleared.push(id);
        timers.delete(id);
      },
    });

    scheduler.scheduleBrowserIdleShutdown(300_000);
    scheduler.scheduleBrowserIdleShutdown(300_000);
    scheduler.scheduleBrowserIdleShutdown(300_000);

    expect(timers.size).toBe(1);
    expect(cleared).toEqual([]);
    expect(nextTimerId).toBe(2);

    timers.get(1).fn();
    expect(closed).toEqual(['idle_shutdown']);
  });

  test('active sessions and missing browser do not schedule shutdown', () => {
    let sessionsSize = 1;
    let browserAlive = true;
    let setTimeoutCalls = 0;
    const scheduler = createIdleShutdownScheduler({
      getSessionsSize: () => sessionsSize,
      hasBrowser: () => browserAlive,
      closeBrowser: () => {},
      setTimeoutFn: () => { setTimeoutCalls++; return setTimeoutCalls; },
      clearTimeoutFn: () => {},
    });

    scheduler.scheduleBrowserIdleShutdown(300_000);
    expect(scheduler.hasTimer).toBe(false);

    sessionsSize = 0;
    browserAlive = false;
    scheduler.scheduleBrowserIdleShutdown(300_000);
    expect(scheduler.hasTimer).toBe(false);
  });

  test('clearing the timer allows a later idle period to schedule once', () => {
    let timerCount = 0;
    const scheduler = createIdleShutdownScheduler({
      getSessionsSize: () => 0,
      hasBrowser: () => true,
      closeBrowser: () => {},
      setTimeoutFn: () => ++timerCount,
      clearTimeoutFn: () => {},
    });

    scheduler.scheduleBrowserIdleShutdown(300_000);
    expect(scheduler.hasTimer).toBe(true);
    scheduler.clearBrowserIdleTimer();
    expect(scheduler.hasTimer).toBe(false);
    scheduler.scheduleBrowserIdleShutdown(300_000);
    expect(timerCount).toBe(2);
  });
});

describe('health during idle browser shutdown', () => {
  test('idle shutdown does not make the Fly health check fail', () => {
    const health = evaluateHealth({ isRecovering: false, browserRunning: false, warming: false, machineId: 'machine-1' });
    expect(health.status).toBe(200);
    expect(health.body).toMatchObject({
      ok: true,
      engine: 'camoufox',
      browserConnected: false,
      browserRunning: false,
      machineId: 'machine-1',
    });
  });

  test('recovering browser still fails health check', () => {
    const health = evaluateHealth({ isRecovering: true, browserRunning: false, warming: false });
    expect(health.status).toBe(503);
    expect(health.body).toEqual({ ok: false, engine: 'camoufox', recovering: true });
  });

  test('active health probe skips idle pre-warmed browsers so idle shutdown can close them', () => {
    expect(shouldRunActiveHealthProbe({
      hasBrowser: true,
      isRecovering: false,
      sessionsSize: 0,
      activeOps: 0,
      timeSinceSuccessMs: 180000,
    })).toBe(false);
  });

  test('active health probe still runs for stale browsers with active sessions', () => {
    expect(shouldRunActiveHealthProbe({
      hasBrowser: true,
      isRecovering: false,
      sessionsSize: 1,
      activeOps: 0,
      timeSinceSuccessMs: 180000,
    })).toBe(true);
  });
});
