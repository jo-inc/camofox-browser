import { jest } from '@jest/globals';
import { createPluginEvents } from '../../lib/plugins.js';
import { register } from './index.js';

describe('persistence-interval plugin', () => {
  let events, ctx, mockApp, sessions;

  const fakeSession = (cookies = 1) => ({
    context: {
      storageState: jest.fn(async () => ({
        cookies: Array.from({ length: cookies }, (_, i) => ({ name: `c${i}` })),
        origins: [],
      })),
    },
  });

  beforeEach(() => {
    jest.useFakeTimers();
    events = createPluginEvents();
    sessions = new Map();
    mockApp = {};
    ctx = { events, sessions, log: jest.fn(), config: {} };
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  test('is off unless an interval is configured', async () => {
    await register(mockApp, ctx, {});
    expect(ctx.log).toHaveBeenCalledWith('info', expect.stringContaining('disabled'));
    expect(jest.getTimerCount()).toBe(0);
  });

  test('a zero interval disables it rather than spinning', async () => {
    // config.js reads `parseInt(env) || default` elsewhere in this codebase, so
    // a falsy value silently restoring a default is a real hazard here. Zero
    // must mean off.
    await register(mockApp, ctx, { intervalMs: 0 });
    expect(jest.getTimerCount()).toBe(0);
  });

  test('emits session:storage:export for each live session on the interval', async () => {
    const seen = [];
    events.on('session:storage:export', ({ userId, storageState }) =>
      seen.push([userId, storageState.cookies.length])
    );
    sessions.set('alice', fakeSession(2));
    sessions.set('bob', fakeSession(3));

    await register(mockApp, ctx, { intervalMs: 1000 });
    await jest.advanceTimersByTimeAsync(1000);

    expect(seen).toEqual([['alice', 2], ['bob', 3]]);
  });

  test('checkpoints repeatedly, not once', async () => {
    let count = 0;
    events.on('session:storage:export', () => { count += 1; });
    sessions.set('alice', fakeSession());

    await register(mockApp, ctx, { intervalMs: 1000 });
    await jest.advanceTimersByTimeAsync(3000);

    expect(count).toBe(3);
  });

  test('does nothing when there are no live sessions', async () => {
    const seen = jest.fn();
    events.on('session:storage:export', seen);
    await register(mockApp, ctx, { intervalMs: 1000 });
    await jest.advanceTimersByTimeAsync(2000);
    expect(seen).not.toHaveBeenCalled();
  });

  // One dead context must not stop the others being checkpointed, and must not
  // kill the timer: a browser that died is exactly when the remaining sessions'
  // accumulated state is most worth saving.
  test('one failing session does not stop the others or the timer', async () => {
    const seen = [];
    events.on('session:storage:export', ({ userId }) => seen.push(userId));
    sessions.set('broken', {
      context: { storageState: jest.fn(async () => { throw new Error('context closed'); }) },
    });
    sessions.set('alice', fakeSession());

    await register(mockApp, ctx, { intervalMs: 1000 });
    await jest.advanceTimersByTimeAsync(2000);

    expect(seen).toEqual(['alice', 'alice']);
    expect(jest.getTimerCount()).toBe(1);
  });

  test('stops on server:shutdown so the process can exit', async () => {
    await register(mockApp, ctx, { intervalMs: 1000 });
    expect(jest.getTimerCount()).toBe(1);
    await events.emitAsync('server:shutdown', {});
    expect(jest.getTimerCount()).toBe(0);
  });

  test('passes the persistence plugin its storageState options', async () => {
    ctx.persistenceStorageStateOptions = { indexedDB: true };
    const session = fakeSession();
    sessions.set('alice', session);

    await register(mockApp, ctx, { intervalMs: 1000 });
    await jest.advanceTimersByTimeAsync(1000);

    expect(session.context.storageState).toHaveBeenCalledWith({ indexedDB: true });
  });
});
