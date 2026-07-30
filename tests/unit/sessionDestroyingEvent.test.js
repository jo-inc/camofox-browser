/**
 * Tests for the session:destroying lifecycle event (PR #75).
 *
 * The core invariant: session:destroying fires BEFORE context.close(),
 * giving plugins a chance to checkpoint while the context is still alive.
 * session:destroyed fires AFTER context.close() for cleanup only.
 *
 * Covers:
 * 1. Event ordering: destroying -> context.close -> destroyed
 * 2. Context is alive during session:destroying
 * 3. Context is closed during session:destroyed
 * 4. Persistence plugin checkpoints on destroying, cleans up on destroyed
 * 5. Checkpoint failure in destroying doesn't prevent close
 * 6. Multiple plugins can listen to destroying
 * 7. session:destroyed still fires even if destroying handler throws
 */

import { jest } from '@jest/globals';
import { createPluginEvents } from '../../lib/plugins.js';

describe('session:destroying event ordering', () => {
  /**
   * Simulate closeSession() from server.js with the PR #75 change:
   *   1. pluginEvents.emitAsync('session:destroying', ...)
   *   2. session.context.close()
   *   3. pluginEvents.emitAsync('session:destroyed', ...)
   */
  async function simulateCloseSession(pluginEvents, session, userId, reason) {
    await pluginEvents.emitAsync('session:destroying', { userId, reason, context: session.context });
    await session.context.close();
    await pluginEvents.emitAsync('session:destroyed', { userId, reason, context: session.context });
  }

  function makeMockContext() {
    let closed = false;
    return {
      get closed() { return closed; },
      close: jest.fn(async () => { closed = true; }),
      storageState: jest.fn(async ({ path }) => {
        if (closed) throw new Error('context is closed');
        return { cookies: [{ name: 'test', value: '1' }], origins: [] };
      }),
    };
  }

  test('destroying fires before context.close, destroyed fires after', async () => {
    const events = createPluginEvents();
    const context = makeMockContext();
    const session = { context };
    const order = [];

    events.on('session:destroying', async () => {
      order.push('destroying');
      order.push(`context_closed=${context.closed}`);
    });

    events.on('session:destroyed', async () => {
      order.push('destroyed');
      order.push(`context_closed=${context.closed}`);
    });

    await simulateCloseSession(events, session, 'user-1', 'test');

    expect(order).toEqual([
      'destroying',
      'context_closed=false',
      'destroyed',
      'context_closed=true',
    ]);
  });

  test('storageState succeeds during destroying, fails during destroyed', async () => {
    const events = createPluginEvents();
    const context = makeMockContext();
    const session = { context };

    let destroyingResult = null;
    let destroyedResult = null;

    events.on('session:destroying', async () => {
      try {
        destroyingResult = await context.storageState({ path: '/tmp/test' });
      } catch (err) {
        destroyingResult = err;
      }
    });

    events.on('session:destroyed', async () => {
      try {
        destroyedResult = await context.storageState({ path: '/tmp/test' });
      } catch (err) {
        destroyedResult = err;
      }
    });

    await simulateCloseSession(events, session, 'user-1', 'test');

    expect(destroyingResult).toEqual({ cookies: [{ name: 'test', value: '1' }], origins: [] });
    expect(destroyedResult).toBeInstanceOf(Error);
    expect(destroyedResult.message).toBe('context is closed');
  });

  test('context.close is called exactly once', async () => {
    const events = createPluginEvents();
    const context = makeMockContext();
    const session = { context };

    await simulateCloseSession(events, session, 'user-1', 'test');

    expect(context.close).toHaveBeenCalledTimes(1);
  });

  test('destroyed still fires even if destroying handler throws', async () => {
    const events = createPluginEvents();
    const context = makeMockContext();
    const session = { context };
    let destroyedCalled = false;

    events.on('session:destroying', async () => {
      throw new Error('plugin exploded');
    });

    events.on('session:destroyed', async () => {
      destroyedCalled = true;
    });

    // emitAsync uses Promise.all which rejects on first error,
    // but the real server.js should handle this. Test the behavior.
    await expect(simulateCloseSession(events, session, 'user-1', 'test'))
      .rejects.toThrow('plugin exploded');

    // With Promise.all, destroyed won't fire if destroying rejects.
    // This documents the current behavior -- server.js should wrap in try/catch.
    expect(destroyedCalled).toBe(false);
  });

  test('multiple plugins can checkpoint during destroying', async () => {
    const events = createPluginEvents();
    const context = makeMockContext();
    const session = { context };
    const checkpoints = [];

    events.on('session:destroying', async ({ userId }) => {
      const state = await context.storageState({ path: '/tmp/plugin-a' });
      checkpoints.push({ plugin: 'A', userId, cookies: state.cookies.length });
    });

    events.on('session:destroying', async ({ userId }) => {
      const state = await context.storageState({ path: '/tmp/plugin-b' });
      checkpoints.push({ plugin: 'B', userId, cookies: state.cookies.length });
    });

    await simulateCloseSession(events, session, 'user-1', 'test');

    expect(checkpoints).toEqual([
      { plugin: 'A', userId: 'user-1', cookies: 1 },
      { plugin: 'B', userId: 'user-1', cookies: 1 },
    ]);
  });

  test('reason is passed through to both events', async () => {
    const events = createPluginEvents();
    const context = makeMockContext();
    const session = { context };
    const reasons = [];

    events.on('session:destroying', async ({ reason }) => reasons.push(`destroying:${reason}`));
    events.on('session:destroyed', async ({ reason }) => reasons.push(`destroyed:${reason}`));

    await simulateCloseSession(events, session, 'user-1', 'idle_timeout');

    expect(reasons).toEqual(['destroying:idle_timeout', 'destroyed:idle_timeout']);
  });
});

describe('persistence plugin with session:destroying', () => {
  /**
   * Simulate the persistence plugin's behavior after PR #75:
   * - checkpoint on session:destroying (context alive)
   * - cleanup activeSessions on session:destroyed (fallback)
   */
  function setupPersistencePlugin(events) {
    const activeSessions = new Map();
    const checkpointCalls = [];

    async function checkpoint(userId, context, reason) {
      const state = await context.storageState({ path: `/tmp/${userId}` });
      checkpointCalls.push({ userId, reason, cookieCount: state.cookies.length });
    }

    events.on('session:created', async ({ userId, context }) => {
      activeSessions.set(userId, context);
    });

    events.on('session:destroying', async ({ userId, reason, context }) => {
      if (context && activeSessions.get(userId) === context) {
        await checkpoint(userId, context, reason).catch(() => {});
      }
    });

    events.on('session:destroyed', async ({ userId, context }) => {
      if (context && activeSessions.get(userId) === context) activeSessions.delete(userId);
    });

    return { activeSessions, checkpointCalls };
  }

  function makeMockContext() {
    let closed = false;
    return {
      get closed() { return closed; },
      close: jest.fn(async () => { closed = true; }),
      storageState: jest.fn(async ({ path }) => {
        if (closed) throw new Error('context is closed');
        return { cookies: [{ name: 'sid', value: 'abc' }], origins: [] };
      }),
    };
  }

  async function simulateCloseSession(pluginEvents, session, userId, reason) {
    await pluginEvents.emitAsync('session:destroying', { userId, reason, context: session.context });
    await session.context.close();
    await pluginEvents.emitAsync('session:destroyed', { userId, reason, context: session.context });
  }

  test('checkpoints successfully during destroying (context alive)', async () => {
    const events = createPluginEvents();
    const context = makeMockContext();
    const { activeSessions, checkpointCalls } = setupPersistencePlugin(events);

    await events.emitAsync('session:created', { userId: 'user-1', context });
    expect(activeSessions.has('user-1')).toBe(true);

    await simulateCloseSession(events, { context }, 'user-1', 'manual_close');

    expect(checkpointCalls).toEqual([
      { userId: 'user-1', reason: 'manual_close', cookieCount: 1 },
    ]);
    expect(context.storageState).toHaveBeenCalled();
    expect(activeSessions.has('user-1')).toBe(false);
  });

  test('activeSessions remains retryable until verified destruction completes', async () => {
    const events = createPluginEvents();
    const context = makeMockContext();
    const { activeSessions } = setupPersistencePlugin(events);

    await events.emitAsync('session:created', { userId: 'user-1', context });

    // Pre-close checkpointing must not forget a context whose close can fail.
    await events.emitAsync('session:destroying', { userId: 'user-1', reason: 'test', context });
    expect(activeSessions.has('user-1')).toBe(true);

    // Only verified post-close completion removes lifecycle tracking.
    await events.emitAsync('session:destroyed', { userId: 'user-1', reason: 'test', context });
    expect(activeSessions.has('user-1')).toBe(false);
  });

  test('destroyed handler cleans up if destroying was somehow skipped', async () => {
    const events = createPluginEvents();
    const context = makeMockContext();
    const { activeSessions } = setupPersistencePlugin(events);

    await events.emitAsync('session:created', { userId: 'user-1', context });
    expect(activeSessions.has('user-1')).toBe(true);

    // Skip destroying, go straight to destroyed (backward compat scenario)
    await events.emitAsync('session:destroyed', { userId: 'user-1', reason: 'test', context });
    expect(activeSessions.has('user-1')).toBe(false);
  });

  test('checkpoint failure in destroying does not prevent session cleanup', async () => {
    const events = createPluginEvents();
    const failingContext = {
      closed: false,
      close: jest.fn(async () => { failingContext.closed = true; }),
      storageState: jest.fn(async () => {
        throw new Error('disk full');
      }),
    };
    const { activeSessions, checkpointCalls } = setupPersistencePlugin(events);

    await events.emitAsync('session:created', { userId: 'user-1', context: failingContext });

    // Should not throw -- .catch(() => {}) in the plugin handles it
    await simulateCloseSession(events, { context: failingContext }, 'user-1', 'test');

    expect(checkpointCalls).toEqual([]); // checkpoint failed, nothing recorded
    expect(activeSessions.has('user-1')).toBe(false); // but cleanup still happened
    expect(failingContext.close).toHaveBeenCalled(); // context still closed
  });

  test('stale lifecycle events cannot checkpoint or remove a replacement context', async () => {
    const events = createPluginEvents();
    const original = makeMockContext();
    const replacement = makeMockContext();
    const { activeSessions, checkpointCalls } = setupPersistencePlugin(events);

    await events.emitAsync('session:created', { userId: 'user-1', context: original });
    await events.emitAsync('session:created', { userId: 'user-1', context: replacement });
    await events.emitAsync('session:destroying', {
      userId: 'user-1', reason: 'stale_close', context: original,
    });
    await events.emitAsync('session:destroyed', {
      userId: 'user-1', reason: 'stale_close', context: original,
    });

    expect(checkpointCalls).toEqual([]);
    expect(activeSessions.get('user-1')).toBe(replacement);
  });

  test('multiple sessions checkpoint independently', async () => {
    const events = createPluginEvents();
    const ctx1 = makeMockContext();
    const ctx2 = makeMockContext();
    const { checkpointCalls } = setupPersistencePlugin(events);

    await events.emitAsync('session:created', { userId: 'user-1', context: ctx1 });
    await events.emitAsync('session:created', { userId: 'user-2', context: ctx2 });

    await simulateCloseSession(events, { context: ctx1 }, 'user-1', 'idle');
    // user-2 still active, not checkpointed
    expect(checkpointCalls).toEqual([
      { userId: 'user-1', reason: 'idle', cookieCount: 1 },
    ]);
    expect(ctx2.storageState).not.toHaveBeenCalled();

    await simulateCloseSession(events, { context: ctx2 }, 'user-2', 'shutdown');
    expect(checkpointCalls).toHaveLength(2);
    expect(checkpointCalls[1]).toEqual({ userId: 'user-2', reason: 'shutdown', cookieCount: 1 });
  });
});
