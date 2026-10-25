/**
 * /tabs/:tabId/evaluate errors must flow through handleRouteError so
 * clients get structured retryable codes instead of a bare 500.
 */
import { describe, test, expect } from '@jest/globals';
import { readFileSync } from 'fs';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';
import {
  browserErrorStatus,
  browserErrorCode,
  browserErrorRecovery,
  isRetryableBrowserError,
} from '../../lib/browser-errors.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const serverSource = readFileSync(resolve(__dirname, '../../server.js'), 'utf8');

describe('evaluate route error handling', () => {
  test('evaluate errors are routed through handleRouteError', () => {
    const start = serverSource.indexOf("app.post('/tabs/:tabId/evaluate'");
    expect(start).toBeGreaterThan(-1);
    const section = serverSource.slice(start, serverSource.indexOf('\napp.', start + 1));
    expect(section).toContain('handleRouteError(err, req, res)');
    expect(section).not.toContain('res.status(500)');
  });

  test('an evaluate timeout does not destroy the tab', () => {
    const start = serverSource.indexOf("app.post('/tabs/:tabId/evaluate'");
    const section = serverSource.slice(start, serverSource.indexOf('\napp.', start + 1));
    expect(section).not.toContain('destroyTimedOutTab');
    expect(section).toContain("code: 'evaluate_timeout'");
  });

  test('the idle reapers spare a tab while an evaluate runs', () => {
    const tabReaper = serverSource.slice(serverSource.indexOf('// Per-tab inactivity reaper'));
    expect(tabReaper).toContain('if (!tabState._lastReaperCheck || isEvaluating(tabState, now)) {');
    const sessionReaper = serverSource.slice(serverSource.indexOf('// Cleanup stale sessions'));
    expect(sessionReaper.indexOf('if (evaluating) session.lastAccess = now;'))
      .toBeLessThan(sessionReaper.indexOf('SESSION_TIMEOUT_MS > 0 && now - session.lastAccess'));
  });

  test('evaluate during a navigation normalizes to 409 navigation_race', () => {
    const err = new Error('page.evaluate: Execution context was destroyed, most likely because of a navigation');
    expect(browserErrorStatus(err)).toBe(409);
    expect(browserErrorCode(err)).toBe('navigation_race');
    expect(isRetryableBrowserError(err)).toBe(true);
  });

  test('evaluate on a dead target normalizes to 503 session_expired', () => {
    const err = new Error('page.evaluate: Target page, context or browser has been closed');
    expect(browserErrorStatus(err)).toBe(503);
    expect(browserErrorCode(err)).toBe('session_expired');
    expect(isRetryableBrowserError(err)).toBe(true);
    expect(browserErrorRecovery(err)).toBe('retry');
  });
});
