import { describe, expect, jest, test } from '@jest/globals';
import { createPageWithSessionRecovery } from '../../lib/new-page-recovery.js';

const isTimeoutError = err => err.code === 'timeout';
const isDeadContextError = err => err.code === 'dead_context';
const withTimeout = promise => promise;
const log = jest.fn();

function recoveryOptions(overrides) {
  return {
    userId: 'user-1',
    trace: false,
    timeoutMs: 10000,
    withTimeout,
    isTimeoutError,
    isDeadContextError,
    log,
    ...overrides,
  };
}

describe('createPageWithSessionRecovery', () => {
  test('replaces an unresponsive session and succeeds on one retry', async () => {
    const timeoutError = Object.assign(new Error('new page timed out'), { code: 'timeout' });
    const oldSession = { context: { newPage: jest.fn().mockRejectedValue(timeoutError) } };
    const page = { id: 'fresh-page' };
    const replacement = { context: { newPage: jest.fn().mockResolvedValue(page) } };
    let mappedSession = oldSession;
    const destroySession = jest.fn(async () => { mappedSession = null; });
    const getSession = jest.fn(async () => replacement);

    const result = await createPageWithSessionRecovery(recoveryOptions({
      session: oldSession,
      currentSession: () => mappedSession,
      destroySession,
      getSession,
    }));

    expect(destroySession).toHaveBeenCalledWith('user-1', { reason: 'new_page_unresponsive' });
    expect(getSession).toHaveBeenCalledWith('user-1', { trace: false });
    expect(result).toEqual({ session: replacement, page });
  });

  test('does not destroy a session another request already replaced', async () => {
    const deadError = Object.assign(new Error('context closed'), { code: 'dead_context' });
    const oldSession = { context: { newPage: jest.fn().mockRejectedValue(deadError) } };
    const replacement = { context: { newPage: jest.fn().mockResolvedValue({ id: 'page' }) } };
    const destroySession = jest.fn();

    await createPageWithSessionRecovery(recoveryOptions({
      session: oldSession,
      currentSession: () => replacement,
      destroySession,
      getSession: async () => replacement,
    }));

    expect(destroySession).not.toHaveBeenCalled();
  });

  test('retries only once', async () => {
    const timeoutError = Object.assign(new Error('new page timed out'), { code: 'timeout' });
    const oldSession = { context: { newPage: jest.fn().mockRejectedValue(timeoutError) } };
    const replacement = { context: { newPage: jest.fn().mockRejectedValue(timeoutError) } };

    await expect(createPageWithSessionRecovery(recoveryOptions({
      session: oldSession,
      currentSession: () => oldSession,
      destroySession: async () => {},
      getSession: async () => replacement,
    }))).rejects.toThrow('new page timed out');

    expect(oldSession.context.newPage).toHaveBeenCalledTimes(1);
    expect(replacement.context.newPage).toHaveBeenCalledTimes(1);
  });

  test('reserves each session while its new-page attempt is pending', async () => {
    const timeoutError = Object.assign(new Error('new page timed out'), { code: 'timeout' });
    const oldSession = { id: 'old', context: { newPage: jest.fn().mockRejectedValue(timeoutError) } };
    const page = { id: 'fresh-page' };
    const replacement = { id: 'replacement', context: { newPage: jest.fn().mockResolvedValue(page) } };
    const releases = [];
    const reservePendingCreation = jest.fn(() => {
      const release = jest.fn();
      releases.push(release);
      return release;
    });

    const result = await createPageWithSessionRecovery(recoveryOptions({
      session: oldSession,
      currentSession: () => oldSession,
      destroySession: async () => {},
      getSession: async () => replacement,
      reservePendingCreation,
    }));

    expect(result).toEqual({ session: replacement, page });
    expect(reservePendingCreation.mock.calls.map(([session]) => session.id)).toEqual(['old', 'replacement']);
    expect(releases).toHaveLength(2);
    expect(releases[0]).toHaveBeenCalledTimes(1);
    expect(releases[1]).toHaveBeenCalledTimes(1);
  });

  test('does not recover unrelated failures', async () => {
    const error = new Error('programming error');
    const session = { context: { newPage: jest.fn().mockRejectedValue(error) } };
    const destroySession = jest.fn();

    await expect(createPageWithSessionRecovery(recoveryOptions({
      session,
      currentSession: () => session,
      destroySession,
      getSession: jest.fn(),
    }))).rejects.toBe(error);

    expect(destroySession).not.toHaveBeenCalled();
  });
});
