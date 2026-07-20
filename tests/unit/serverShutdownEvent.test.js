/**
 * Tests for the server:shutdown lifecycle event ordering.
 *
 * The core invariant: server:shutdown listeners must finish running
 * BEFORE gracefulShutdown() proceeds to close session contexts, so
 * that a plugin's checkpoint-on-shutdown (e.g. persistence) can read
 * context.storageState() while the context is still alive.
 *
 * server.js previously fired this event with plain EventEmitter#emit,
 * which does not wait for async listeners. gracefulShutdown() then
 * called closeAllSessions() immediately after, racing the in-flight
 * checkpoint against context.close() -- intermittently failing with
 * "Target page, context or browser has been closed".
 *
 * The fix: emit via pluginEvents.emitAsync() and await it before
 * closing any session.
 */

import { jest } from '@jest/globals';
import { createPluginEvents } from '../../lib/plugins.js';

function makeMockContext() {
  let closed = false;
  return {
    get closed() { return closed; },
    close: jest.fn(async () => { closed = true; }),
    storageState: jest.fn(async () => {
      // Real Playwright calls cross into the browser process, yielding the
      // event loop -- simulate that with a macrotask so a concurrent
      // context.close() can interleave and "win" the race when the caller
      // doesn't await the shutdown listener first.
      await new Promise((resolve) => setTimeout(resolve, 0));
      if (closed) throw new Error('Target page, context or browser has been closed');
      return { cookies: [{ name: 'test', value: '1' }], origins: [] };
    }),
  };
}

describe('server:shutdown event ordering', () => {
  /**
   * Simulate gracefulShutdown() from server.js as it is today:
   *   1. await pluginEvents.emitAsync('server:shutdown', { signal })
   *   2. closeAllSessions() -> context.close() per session
   */
  async function simulateGracefulShutdown(pluginEvents, sessions) {
    await pluginEvents.emitAsync('server:shutdown', { signal: 'SIGTERM' });
    for (const context of sessions.values()) {
      await context.close();
    }
  }

  test('shutdown checkpoint completes before any context is closed', async () => {
    const events = createPluginEvents();
    const context = makeMockContext();
    const sessions = new Map([['user-1', context]]);
    let checkpointed = null;

    events.on('server:shutdown', async () => {
      checkpointed = await context.storageState();
    });

    await simulateGracefulShutdown(events, sessions);

    expect(checkpointed).toEqual({ cookies: [{ name: 'test', value: '1' }], origins: [] });
    expect(context.closed).toBe(true);
  });

  test('multiple sessions all checkpoint before any of them close', async () => {
    const events = createPluginEvents();
    const sessions = new Map([
      ['user-1', makeMockContext()],
      ['user-2', makeMockContext()],
    ]);
    const results = new Map();

    events.on('server:shutdown', async () => {
      for (const [userId, context] of sessions) {
        results.set(userId, await context.storageState());
      }
    });

    await simulateGracefulShutdown(events, sessions);

    expect(results.size).toBe(2);
    for (const context of sessions.values()) {
      expect(context.closed).toBe(true);
    }
  });

  test('regression guard: plain emit() (pre-fix behavior) does not wait, so checkpoint races context.close', async () => {
    const events = createPluginEvents();
    const context = makeMockContext();
    const sessions = new Map([['user-1', context]]);
    let checkpointError = null;

    events.on('server:shutdown', async () => {
      try {
        await context.storageState();
      } catch (err) {
        checkpointError = err;
      }
    });

    // Simulate the old buggy call site: fire-and-forget emit(), immediately
    // followed by closing sessions -- this is what server.js did before the fix.
    events.emit('server:shutdown', { signal: 'SIGTERM' });
    for (const c of sessions.values()) {
      await c.close();
    }

    // Nothing awaited the fire-and-forget listener above -- give its
    // in-flight checkpoint a chance to settle before asserting, same as
    // the real bug: the listener finishes on its own, after the damage
    // (context already closed) is done.
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(checkpointError).not.toBeNull();
    expect(checkpointError.message).toMatch(/context or browser has been closed/);
  });
});
