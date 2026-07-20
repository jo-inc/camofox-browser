import {
  safePageUrl,
  urlDomain,
  hashIdentifier,
  isPageCrashedError,
  isDeadContextError,
  browserErrorStatus,
  browserErrorCode,
  browserErrorRecovery,
  isRetryableBrowserError,
} from '../../lib/browser-errors.js';

describe('browser error normalization', () => {
  test('safePageUrl never throws on undefined or destroyed pages', () => {
    expect(safePageUrl(undefined)).toBe('unknown');
    expect(safePageUrl({ url: () => { throw new TypeError('Cannot read properties of undefined (reading \'url\')'); } })).toBe('unknown');
    expect(safePageUrl({ url: () => 'https://example.com/path?secret=1' })).toBe('https://example.com/path?secret=1');
  });

  test('extracts only URL domain for Sentry context', () => {
    expect(urlDomain('https://sub.example.com/path?token=secret')).toBe('sub.example.com');
    expect(urlDomain('unknown')).toBe('unknown');
  });

  test('hashIdentifier is stable and does not expose raw ids', () => {
    const hash = hashIdentifier('user-123');
    expect(hash).toMatch(/^[0-9a-f]{12}$/);
    expect(hash).toBe(hashIdentifier('user-123'));
    expect(hash).not.toContain('user-123');
  });

  test('page crashes normalize to 410 page_crashed', () => {
    const err = new Error('page.goto: Page crashed');
    expect(isPageCrashedError(err)).toBe(true);
    expect(browserErrorStatus(err)).toBe(410);
    expect(browserErrorCode(err)).toBe('page_crashed');
  });

  test('dead browser contexts normalize to 503 session_expired', () => {
    const err = new Error('Target page, context or browser has been closed');
    expect(isDeadContextError(err)).toBe(true);
    expect(browserErrorStatus(err)).toBe(503);
    expect(browserErrorCode(err)).toBe('session_expired');
    expect(isRetryableBrowserError(err)).toBe(true);
    expect(browserErrorRecovery(err)).toBe('retry');
  });

  test('stale refs normalize to structured snapshot retry', () => {
    const err = Object.assign(new Error('Unknown ref: e9'), { name: 'StaleRefsError', code: 'stale_refs' });
    expect(browserErrorStatus(err)).toBe(422);
    expect(browserErrorCode(err)).toBe('stale_refs');
    expect(browserErrorRecovery(err)).toBe('snapshot_then_retry');
  });

  test('navigation races normalize to 409 retryable', () => {
    const err = new Error('Execution context was destroyed, most likely because of a navigation');
    expect(browserErrorStatus(err)).toBe(409);
    expect(browserErrorCode(err)).toBe('navigation_race');
    expect(browserErrorRecovery(err)).toBe('snapshot_then_retry');
  });

  test('Firefox interrupted navigations normalize to retryable navigation races', () => {
    for (const message of ['page.goto: NS_ERROR_NET_INTERRUPT', 'page.reload: NS_BINDING_ABORTED']) {
      const err = new Error(message);
      expect(browserErrorStatus(err)).toBe(409);
      expect(browserErrorCode(err)).toBe('navigation_race');
      expect(browserErrorRecovery(err)).toBe('snapshot_then_retry');
    }
  });

  test('ambiguous selectors normalize to structured snapshot retry', () => {
    const err = new Error("locator.click: Error: strict mode violation: locator('td') resolved to 62 elements:");
    expect(browserErrorStatus(err)).toBe(422);
    expect(browserErrorCode(err)).toBe('ambiguous_selector');
    expect(browserErrorRecovery(err)).toBe('snapshot_then_retry');
  });

  test('malformed fill values normalize to element actionability errors', () => {
    const err = new Error('locator.fill: Error: Malformed value');
    expect(browserErrorStatus(err)).toBe(422);
    expect(browserErrorCode(err)).toBe('element_not_actionable');
  });

  test('non-fillable submit inputs normalize to element actionability errors', () => {
    const err = Object.assign(
      new Error('Element input[type=submit] is not fillable. Use click for buttons and other controls.'),
      { code: 'element_not_actionable', statusCode: 422 }
    );
    expect(browserErrorStatus(err)).toBe(422);
    expect(browserErrorCode(err)).toBe('element_not_actionable');
    expect(browserErrorRecovery(err)).toBe('snapshot_then_retry');
  });

  test('invalid selector syntax normalizes to non-retryable 400', () => {
    const err = new Error('locator.fill: Unexpected token "[" while parsing selector "text=[broken"');
    expect(browserErrorStatus(err)).toBe(400);
    expect(browserErrorCode(err)).toBe('invalid_selector');
    expect(isRetryableBrowserError(err)).toBe(false);
  });

  test('launch and user concurrency timeouts normalize to 503 retry', () => {
    const launch = new Error('Browser launch timeout (60s)');
    const concurrency = new Error('User concurrency limit reached, try again');
    expect(browserErrorStatus(launch)).toBe(503);
    expect(browserErrorCode(launch)).toBe('browser_launch_timeout');
    expect(browserErrorRecovery(launch)).toBe('retry');
    expect(browserErrorStatus(concurrency)).toBe(503);
    expect(browserErrorCode(concurrency)).toBe('concurrency_timeout');
    expect(browserErrorRecovery(concurrency)).toBe('retry');
  });
});
