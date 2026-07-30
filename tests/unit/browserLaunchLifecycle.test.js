import { jest } from '@jest/globals';
import {
  createBrowserLaunchGeneration,
  closeAndDrainBrowserLaunch,
  waitForLaunchWithTimeout,
  runBackgroundBrowserOperation,
} from '../../lib/browser-launch-lifecycle.js';

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('browser launch lifecycle', () => {
  test('a timeout does not cancel or forget the underlying launch task', async () => {
    jest.useFakeTimers();
    const launch = deferred();
    const caller = waitForLaunchWithTimeout(launch.promise, 10);
    jest.advanceTimersByTime(10);
    await expect(caller).rejects.toThrow('Browser launch timeout');

    launch.resolve('browser');
    await expect(launch.promise).resolves.toBe('browser');
    jest.useRealTimers();
  });

  test('an invalidated launch cannot publish after stop or replacement', async () => {
    const generation = createBrowserLaunchGeneration();
    const first = generation.begin();
    generation.invalidate();

    expect(() => generation.assertCurrent(first)).toThrow(expect.objectContaining({
      code: 'browser_launch_superseded',
    }));

    const replacement = generation.begin();
    expect(() => generation.assertCurrent(replacement)).not.toThrow();
    expect(() => generation.assertCurrent(first)).toThrow(expect.objectContaining({
      code: 'browser_launch_superseded',
    }));
  });

  test('drains an in-flight launch even when browser cleanup rejects', async () => {
    const launch = deferred();
    const closeError = new Error('process snapshot failed');
    let settled = false;
    const closing = closeAndDrainBrowserLaunch(
      async () => { throw closeError; },
      launch.promise,
    ).finally(() => { settled = true; });

    await Promise.resolve();
    expect(settled).toBe(false);
    launch.resolve('stale candidate disposed');
    await expect(closing).rejects.toBe(closeError);
    expect(settled).toBe(true);
  });

  test('background cleanup reports close failure without rejecting', async () => {
    const error = new Error('process snapshot failed');
    const onError = jest.fn();

    await expect(runBackgroundBrowserOperation(
      async () => { throw error; },
      onError,
    )).resolves.toBeUndefined();
    expect(onError).toHaveBeenCalledWith(error);
  });

  test('background cleanup remains settled if failure reporting also throws', async () => {
    await expect(runBackgroundBrowserOperation(
      async () => { throw new Error('close failed'); },
      () => { throw new Error('logger failed'); },
    )).resolves.toBeUndefined();
  });
});
