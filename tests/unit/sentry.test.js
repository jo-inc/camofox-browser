import { shouldDropOperationalError } from '../../lib/sentry.js';

describe('sentry operational error filtering', () => {
  test('drops Playwright page JavaScript errors surfaced through Firefox internals', () => {
    const err = new TypeError("Cannot read properties of undefined (reading 'url')");
    err.stack = [
      "TypeError: Cannot read properties of undefined (reading 'url')",
      '    at /app/node_modules/playwright-core/lib/coreBundle.js:42785:1',
      '    at FFPage._onUncaughtError (/app/node_modules/playwright-core/lib/coreBundle.js:43470:1)',
      '    at _Page.addPageError (/app/node_modules/playwright-core/lib/coreBundle.js:19951:1)',
    ].join('\n');

    expect(shouldDropOperationalError(err)).toBe(true);
  });

  test('drops expected browser/navigation operational errors', () => {
    expect(shouldDropOperationalError(new Error('page.goto: NS_ERROR_NET_INTERRUPT'))).toBe(true);
    expect(shouldDropOperationalError(new Error('page.reload: NS_BINDING_ABORTED'))).toBe(true);
    expect(shouldDropOperationalError(new Error("locator.click: Error: strict mode violation: locator('td') resolved to 62 elements:"))).toBe(true);
    expect(shouldDropOperationalError(new Error('locator.fill: Error: Malformed value'))).toBe(true);
  });

  test('drops Playwright Firefox navigation bookkeeping races', () => {
    const err = new TypeError("Cannot read properties of undefined (reading '_getChildFrames')");
    err.stack = [
      "TypeError: Cannot read properties of undefined (reading '_getChildFrames')",
      '    at FFPage._onNavigationCommitted (/app/node_modules/playwright-core/lib/coreBundle.js:1:1)',
      '    at FrameManager.removeChildFramesRecursively (/app/node_modules/playwright-core/lib/coreBundle.js:1:1)',
    ].join('\n');

    expect(shouldDropOperationalError(err)).toBe(true);
  });

  test('keeps ordinary application errors', () => {
    expect(shouldDropOperationalError(new Error('route handler failed'))).toBe(false);
  });
});
