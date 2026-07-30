export function createBrowserLaunchGeneration() {
  let current = 0;
  return {
    begin() {
      current += 1;
      return current;
    },
    invalidate() {
      current += 1;
    },
    assertCurrent(generation) {
      if (generation !== current) {
        throw Object.assign(new Error('Browser launch was superseded before publication'), {
          code: 'browser_launch_superseded',
        });
      }
    },
  };
}

export function waitForLaunchWithTimeout(task, timeoutMs) {
  let timeout;
  return Promise.race([
    task,
    new Promise((_, reject) => {
      timeout = setTimeout(
        () => reject(new Error(`Browser launch timeout (${Math.round(timeoutMs / 1000)}s)`)),
        timeoutMs,
      );
    }),
  ]).finally(() => clearTimeout(timeout));
}

export async function closeAndDrainBrowserLaunch(closeBrowser, launchTask) {
  try {
    await closeBrowser();
  } finally {
    await launchTask?.catch(() => {});
  }
}

export async function runBackgroundBrowserOperation(operation, onError) {
  try {
    return await operation();
  } catch (error) {
    try {
      onError(error);
    } catch {
      // A background timer must never surface a second unhandled rejection
      // merely because diagnostics or retry scheduling failed.
    }
    return undefined;
  }
}
