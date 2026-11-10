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
    expect(result).toMatchObject({ session: replacement, page });
    expect(result.lease).toMatchObject({ page, released: false });
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

  test('keeps a responsive session when newPage times out and closes a late page', async () => {
    const timeoutError = Object.assign(new Error('new page timed out'), { code: 'timeout' });
    let resolvePage;
    const pendingPage = new Promise(resolve => { resolvePage = resolve; });
    const probePage = { isClosed: () => false, evaluate: jest.fn().mockResolvedValue(true) };
    const session = {
      context: { newPage: jest.fn(() => pendingPage), pages: () => [probePage] },
    };
    const destroySession = jest.fn();
    const getSession = jest.fn();

    await expect(createPageWithSessionRecovery(recoveryOptions({
      session,
      currentSession: () => session,
      destroySession,
      getSession,
      withTimeout: (promise, _timeoutMs, label) =>
        label === 'new page' ? Promise.reject(timeoutError) : promise,
    }))).rejects.toMatchObject({
      code: 'new_page_timeout',
      statusCode: 503,
    });

    expect(probePage.evaluate).toHaveBeenCalledWith(expect.any(Function));
    expect(destroySession).not.toHaveBeenCalled();
    expect(getSession).not.toHaveBeenCalled();

    const latePage = { close: jest.fn().mockResolvedValue(undefined) };
    resolvePage(latePage);
    await Promise.resolve();
    await Promise.resolve();
    expect(latePage.close).toHaveBeenCalledTimes(1);
  });

  test('rebuilds a timed-out session when its existing page cannot answer the probe', async () => {
    const timeoutError = Object.assign(new Error('new page timed out'), { code: 'timeout' });
    const session = {
      context: {
        newPage: jest.fn().mockRejectedValue(timeoutError),
        pages: () => [{ isClosed: () => false, evaluate: jest.fn().mockRejectedValue(new Error('closed')) }],
      },
    };
    const replacement = { context: { newPage: jest.fn().mockResolvedValue({ id: 'fresh' }) } };
    const destroySession = jest.fn();

    await createPageWithSessionRecovery(recoveryOptions({
      session,
      currentSession: () => session,
      destroySession,
      getSession: async () => replacement,
    }));

    expect(destroySession).toHaveBeenCalledWith('user-1', { reason: 'new_page_unresponsive' });
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
