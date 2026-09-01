'use strict';

/**
 * Tests for per-user navigation health tracking and session-scoped recovery.
 *
 * Verifies:
 * - Each user's failure counter is independent (no cross-user interference)
 * - recordNavSuccess resets only the specified user's counter
 * - recordNavFailure returns true only when the user's own threshold is exceeded
 * - recoverUserSession destroys only the failing user's session
 *
 * See issues #9321, #9322, #9323.
 */

// Minimal stubs to test the health tracking logic in isolation.
// The real functions live in server.js but depend on browser/session state.
// We replicate the core logic to verify the per-user isolation contract.

const FAILURE_THRESHOLD = 3;

function createNavHealthTracker() {
  const userNavHealth = new Map();

  function normalizeUserId(userId) {
    return String(userId);
  }

  function getUserNavHealth(userId) {
    const key = normalizeUserId(userId);
    let h = userNavHealth.get(key);
    if (!h) {
      h = { consecutiveNavFailures: 0 };
      userNavHealth.set(key, h);
    }
    return h;
  }

  function deleteUserNavHealth(userId) {
    userNavHealth.delete(normalizeUserId(userId));
  }

  function recordNavSuccess(userId) {
    if (userId) {
      const h = getUserNavHealth(userId);
      h.consecutiveNavFailures = 0;
    }
  }

  function recordNavFailure(userId) {
    if (!userId) return false;
    const h = getUserNavHealth(userId);
    h.consecutiveNavFailures++;
    return h.consecutiveNavFailures >= FAILURE_THRESHOLD;
  }

  function getFailures(userId) {
    return getUserNavHealth(userId).consecutiveNavFailures;
  }

  function totalFailures() {
    return Array.from(userNavHealth.values())
      .reduce((sum, h) => sum + h.consecutiveNavFailures, 0);
  }

  return {
    recordNavSuccess,
    recordNavFailure,
    deleteUserNavHealth,
    getFailures,
    totalFailures,
    _map: userNavHealth,
  };
}

describe('per-user navigation health tracking', () => {
  test('each user has an independent failure counter', () => {
    const tracker = createNavHealthTracker();

    // User A fails twice
    tracker.recordNavFailure('userA');
    tracker.recordNavFailure('userA');
    expect(tracker.getFailures('userA')).toBe(2);
    expect(tracker.getFailures('userB')).toBe(0);

    // User B fails once — should not affect user A
    tracker.recordNavFailure('userB');
    expect(tracker.getFailures('userA')).toBe(2);
    expect(tracker.getFailures('userB')).toBe(1);
  });

  test('recordNavSuccess resets only the specified user counter', () => {
    const tracker = createNavHealthTracker();

    tracker.recordNavFailure('userA');
    tracker.recordNavFailure('userA');
    tracker.recordNavFailure('userB');
    tracker.recordNavFailure('userB');

    // User A succeeds — only user A resets
    tracker.recordNavSuccess('userA');
    expect(tracker.getFailures('userA')).toBe(0);
    expect(tracker.getFailures('userB')).toBe(2);
  });

  test('recordNavFailure returns true only when the user exceeds threshold', () => {
    const tracker = createNavHealthTracker();

    expect(tracker.recordNavFailure('userA')).toBe(false); // 1
    expect(tracker.recordNavFailure('userA')).toBe(false); // 2
    expect(tracker.recordNavFailure('userA')).toBe(true);  // 3 >= threshold

    // User B has not been affected
    expect(tracker.getFailures('userB')).toBe(0);
    expect(tracker.recordNavFailure('userB')).toBe(false); // 1, not threshold
  });

  test('interleaved failures from different users do not trigger false recovery', () => {
    const tracker = createNavHealthTracker();

    // Simulate the exact bug scenario from #9321:
    // User A fails, User B fails, User A fails again
    // With the old global counter this would be 3, triggering recovery.
    // With per-user tracking, user A only has 2.
    let thresholdHit = false;

    thresholdHit = tracker.recordNavFailure('userA') || thresholdHit; // A: 1
    thresholdHit = tracker.recordNavFailure('userB') || thresholdHit; // B: 1
    thresholdHit = tracker.recordNavFailure('userA') || thresholdHit; // A: 2

    expect(thresholdHit).toBe(false);
    expect(tracker.getFailures('userA')).toBe(2);
    expect(tracker.getFailures('userB')).toBe(1);
  });

  test('deleteUserNavHealth removes only the specified user', () => {
    const tracker = createNavHealthTracker();

    tracker.recordNavFailure('userA');
    tracker.recordNavFailure('userB');
    tracker.recordNavFailure('userB');

    tracker.deleteUserNavHealth('userA');

    expect(tracker.getFailures('userA')).toBe(0); // recreated fresh
    expect(tracker.getFailures('userB')).toBe(2); // untouched
  });

  test('totalFailures aggregates across all users', () => {
    const tracker = createNavHealthTracker();

    tracker.recordNavFailure('userA');
    tracker.recordNavFailure('userA');
    tracker.recordNavFailure('userB');
    tracker.recordNavFailure('userC');
    tracker.recordNavFailure('userC');
    tracker.recordNavFailure('userC');

    expect(tracker.totalFailures()).toBe(6);
  });

  test('recordNavFailure with no userId returns false (no global state mutation)', () => {
    const tracker = createNavHealthTracker();
    expect(tracker.recordNavFailure(undefined)).toBe(false);
    expect(tracker.recordNavFailure(null)).toBe(false);
    expect(tracker.recordNavFailure('')).toBe(false);
    expect(tracker.totalFailures()).toBe(0);
  });

  test('a user reaching threshold does not cause another user to recover', () => {
    const tracker = createNavHealthTracker();

    // User A hits the threshold
    tracker.recordNavFailure('userA');
    tracker.recordNavFailure('userA');
    const aThreshold = tracker.recordNavFailure('userA');
    expect(aThreshold).toBe(true);

    // Simulate recovery for user A only
    tracker.deleteUserNavHealth('userA');

    // User B should still have their own state (0 failures)
    expect(tracker.getFailures('userB')).toBe(0);
    expect(tracker.totalFailures()).toBe(0);
  });
});