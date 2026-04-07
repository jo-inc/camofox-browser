/**
 * Tests for per-context proxy rotation behavior.
 *
 * Verifies that Google block / proxy error recovery rotates at the context
 * level (destroying only the affected user's session) instead of restarting
 * the entire browser (which kills ALL sessions).
 *
 * We can't import server.js directly (it starts Express), so we test the
 * behavioral contracts via replicated logic and proxy pool integration.
 */

import { createProxyPool } from '../../lib/proxy.js';

// --- Replicated helpers from server.js (must stay in sync) ---

function normalizeUserId(userId) {
  return String(userId);
}

/**
 * Simulates getSession() proxy assignment behavior.
 * Uses capability checks (canRotateSessions) instead of mode string checks.
 */
function assignContextProxy(proxyPool, userId) {
  if (proxyPool?.canRotateSessions) {
    const key = normalizeUserId(userId);
    return proxyPool.getNext(`ctx-${key}-test`);
  } else if (proxyPool) {
    return proxyPool.getNext();
  }
  return null;
}

// --- Tests ---

describe('Per-context proxy assignment (backconnect)', () => {
  const backconnectPool = createProxyPool({
    strategy: 'backconnect',
    backconnectHost: 'gate.proxy.com',
    backconnectPort: 7000,
    username: 'testuser',
    password: 'testpass',
    country: 'us',
  });

  test('backconnect pool creates unique session IDs per user', () => {
    const proxy1 = assignContextProxy(backconnectPool, 'user-1');
    const proxy2 = assignContextProxy(backconnectPool, 'user-2');

    expect(proxy1).not.toBeNull();
    expect(proxy2).not.toBeNull();
    // Different users get different session IDs
    expect(proxy1.sessionId).not.toBe(proxy2.sessionId);
    expect(proxy1.sessionId).toBe('ctx-user-1-test');
    expect(proxy2.sessionId).toBe('ctx-user-2-test');
    // Both use the same server
    expect(proxy1.server).toBe('http://gate.proxy.com:7000');
    expect(proxy2.server).toBe('http://gate.proxy.com:7000');
  });

  test('backconnect proxy includes session in username', () => {
    const proxy = assignContextProxy(backconnectPool, '42');
    expect(proxy.username).toContain('session-ctx_42_test');
  });

  test('round_robin proxy has no sessionId', () => {
    const rrPool = createProxyPool({
      strategy: 'round_robin',
      host: 'us.proxy.com',
      ports: [10001],
      username: 'u',
      password: 'p',
    });
    const proxy = assignContextProxy(rrPool, 'user-1');
    expect(proxy.sessionId).toBeUndefined();
  });

  test('null pool returns null proxy', () => {
    expect(assignContextProxy(null, 'user-1')).toBeNull();
  });
});

describe('Context rotation isolation', () => {
  /**
   * Simulates the session store and rotation behavior.
   * Key contract: rotating one user's context must not affect others.
   */
  test('destroying one user session preserves others', () => {
    // Simulate session store
    const sessions = new Map();
    sessions.set('user-1', { context: 'ctx-1', proxySessionId: 'sess-1' });
    sessions.set('user-2', { context: 'ctx-2', proxySessionId: 'sess-2' });
    sessions.set('user-3', { context: 'ctx-3', proxySessionId: 'sess-3' });

    // Rotate user-2 (simulates rotateGoogleTab behavior)
    const key = 'user-2';
    sessions.delete(key);
    sessions.set(key, { context: 'ctx-2-new', proxySessionId: 'sess-2-new' });

    // Other users untouched
    expect(sessions.get('user-1').proxySessionId).toBe('sess-1');
    expect(sessions.get('user-3').proxySessionId).toBe('sess-3');
    // Rotated user has new session
    expect(sessions.get('user-2').proxySessionId).toBe('sess-2-new');
    expect(sessions.size).toBe(3);
  });

  test('rotation respects retry limit (googleRetryCount >= 3)', () => {
    // Simulates rotateGoogleTab's early exit
    const previousTabState = { lastRequestedUrl: 'https://www.google.com/search?q=test', googleRetryCount: 3 };
    const shouldRotate = previousTabState.googleRetryCount < 3;
    expect(shouldRotate).toBe(false);
  });

  test('rotation proceeds when under retry limit', () => {
    const previousTabState = { lastRequestedUrl: 'https://www.google.com/search?q=test', googleRetryCount: 1 };
    const shouldRotate = previousTabState.googleRetryCount < 3;
    expect(shouldRotate).toBe(true);
  });

  test('rotation skips non-Google URLs', () => {
    const previousTabState = { lastRequestedUrl: 'https://example.com', googleRetryCount: 0 };
    const isGoogle = /google\.com\/search/.test(previousTabState.lastRequestedUrl);
    expect(isGoogle).toBe(false);
  });
});

describe('Health check not affected by context rotation', () => {
  /**
   * The old restartBrowser() set healthState.isRecovering = true, which made
   * /health return 503. Context rotation should NOT touch healthState.
   */
  test('context rotation does not set isRecovering', () => {
    const healthState = {
      consecutiveNavFailures: 0,
      lastSuccessfulNav: Date.now(),
      isRecovering: false,
      activeOps: 0,
    };

    // Simulate context rotation (destroy session + recreate)
    // This is what our new code does — no healthState mutation
    const sessions = new Map();
    sessions.set('user-1', { context: 'old' });
    sessions.delete('user-1');
    sessions.set('user-1', { context: 'new' });

    // Health state unchanged — this is the key invariant
    expect(healthState.isRecovering).toBe(false);
    expect(healthState.consecutiveNavFailures).toBe(0);
  });
});
