/**
 * Tests for the bounded boundingBox() call in the /click mouse-sequence fallback.
 *
 * Regression: when a click attempt failed (element detached after the page
 * changed under us, e.g. a SPA re-render between snapshot and click), the
 * mouse-sequence fallback called locator.boundingBox() with NO timeout.
 * Playwright then waited its default 30s for the element to become resolvable,
 * which blew the entire HANDLER_TIMEOUT_MS budget and surfaced as:
 *
 *   {"level":"error","msg":"click failed","error":"action timed out after 30000ms"}
 *   {"level":"error","msg":"internal error","error":"action timed out after 30000ms"}
 *   -> 500 to the client
 *
 * The fix bounds boundingBox() to min(3s, remaining budget) and throws a
 * 422 "Element not actionable" error that:
 *   1. fails fast (~3s instead of ~30s),
 *   2. is NOT classified as a timeout error (so handleRouteError does not
 *      destroy the whole user session over a detached element),
 *   3. tells the caller to snapshot + retry.
 */
import { describe, test, expect } from '@jest/globals';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const serverSrc = readFileSync(join(__dirname, '../../server.js'), 'utf8');

// Mirror of isTimeoutError from server.js (kept in sync; see navigationTimeout.test.js)
function isTimeoutError(err) {
  if (!err) return false;
  const msg = err.message || '';
  return msg.includes('timed out after') || (msg.includes('Timeout') && msg.includes('exceeded'));
}

// Mirror of the bboxTimeout computation in the /click handler
function computeBboxTimeout(remainingBudgetMs) {
  return Math.max(500, Math.min(3000, remainingBudgetMs));
}

describe('/click mouse-sequence boundingBox bounding', () => {
  describe('server.js source contract', () => {
    test('boundingBox in the mouse-sequence fallback is called with an explicit timeout', () => {
      // Any bare `locator.boundingBox()` (no options) inside server.js would
      // reintroduce the 30s default-timeout hang.
      const bare = serverSrc.match(/\.boundingBox\(\s*\)/g) || [];
      expect(bare).toHaveLength(0);
      expect(serverSrc).toMatch(/\.boundingBox\(\{\s*timeout:\s*bboxTimeout\s*\}\)/);
    });

    test('detached-element error carries statusCode 422', () => {
      const idx = serverSrc.indexOf('Element not actionable: no bounding box within');
      expect(idx).toBeGreaterThan(-1);
      const surrounding = serverSrc.slice(idx, idx + 400);
      expect(surrounding).toMatch(/statusCode = 422/);
    });
  });

  describe('bboxTimeout budget math', () => {
    test('caps at 3s even with a full budget', () => {
      expect(computeBboxTimeout(28000)).toBe(3000);
    });

    test('uses remaining budget when below the cap', () => {
      expect(computeBboxTimeout(1800)).toBe(1800);
    });

    test('floors at 500ms when the budget is exhausted', () => {
      expect(computeBboxTimeout(0)).toBe(500);
      expect(computeBboxTimeout(-100)).toBe(500);
    });
  });

  describe('error classification (session must survive a detached element)', () => {
    test('detached-element error is NOT classified as a timeout error', () => {
      const err = new Error(
        'Element not actionable: no bounding box within 3000ms (element likely detached after page change). Call snapshot to refresh refs and retry.'
      );
      // If this were classified as a timeout, handleRouteError would destroy
      // the entire user session ('navigation timeout — destroying session for
      // fresh proxy') over a stale ref. It must not be.
      expect(isTimeoutError(err)).toBe(false);
    });

    test('the old unbounded behavior WAS classified as a session-destroying timeout', () => {
      // Documents the bug being fixed: the generic withTimeout wrapper error.
      const err = new Error('action timed out after 30000ms');
      expect(isTimeoutError(err)).toBe(true);
    });
  });
});
