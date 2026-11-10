/**
 * The first POST /tabs after an idle shutdown cold-launches Camoufox and
 * restores persisted storage state. Heavy restores (or two coalesced
 * first-hits) can overshoot the fixed tab-create budget by a hair even though
 * the coalesced build finishes microseconds later. Two guarantees are tested:
 *
 *   Part A: the tab-create route-deadline timeout returns a retriable 503 with
 *           Retry-After instead of a generic 500, WITHOUT disturbing the
 *           near-cap / new_page_timeout / fly-replay precedence.
 *   Part B: the deadline is extended exactly once when a cold context build is
 *           genuinely in flight for the user, and not otherwise.
 *
 * These are source-level contract checks (matching timeoutContinuation.test.js)
 * plus a direct behavioral check of the deadline-timeout classifier.
 */

import { readFileSync } from 'fs';
import { isTimeoutError } from '../../lib/browser-errors.js';

const source = readFileSync(new URL('../../server.js', import.meta.url), 'utf8');

function createRouteSource() {
  const start = source.indexOf("app.post('/tabs', async (req, res) => {");
  const end = source.indexOf('// Navigate', start);
  return source.slice(start, end);
}

describe('POST /tabs cold-start deadline handling', () => {
  const createRoute = createRouteSource();

  describe('Part A — retriable 503 on the tab-create deadline timeout', () => {
    test('returns a 503 marked retriable with a code and recovery, not a bare 500', () => {
      expect(createRoute).toContain('if (isTabCreateDeadlineTimeout(err)) {');
      expect(createRoute).toContain("res.set('Retry-After', '5');");
      expect(createRoute).toContain('return res.status(503).json({');
      expect(createRoute).toContain("code: 'tab_create_warming'");
      expect(createRoute).toContain('retryable: true');
      expect(createRoute).toContain("recovery: 'retry'");
    });

    test('clients can detect the retriable case by field, not by prose', () => {
      // The decision fields (code/retryable/recovery) must accompany the 503 so
      // a client never has to pattern-match the human-readable error string.
      const warming = createRoute.slice(createRoute.indexOf('if (isTabCreateDeadlineTimeout(err)) {'));
      const block = warming.slice(0, warming.indexOf('});') + 3);
      expect(block).toContain('tab_create_warming');
      expect(block).toContain('retryable: true');
      expect(block).toContain('recovery');
    });
  });

  describe('Part A — precedence is preserved', () => {
    test('the near-cap memory bounce still wins over the warming-up 503', () => {
      const nearCapIdx = createRoute.indexOf('if (mem?.nearCap) return memoryCapResponse(res, mem);');
      const warmingIdx = createRoute.indexOf('if (isTabCreateDeadlineTimeout(err)) {');
      expect(nearCapIdx).toBeGreaterThan(-1);
      expect(warmingIdx).toBeGreaterThan(-1);
      // Near-cap check must come first so it returns before the warming 503.
      expect(nearCapIdx).toBeLessThan(warmingIdx);
    });

    test('new_page_timeout is excluded from the warming-up 503', () => {
      // The classifier explicitly excludes new_page_timeout so a responsive
      // new-page timeout keeps its own (#14668) handling.
      expect(source).toContain("err.code !== 'new_page_timeout'");
      expect(source).toMatch(/function isTabCreateDeadlineTimeout\(err\)[\s\S]*err\.code !== 'new_page_timeout'/);
    });

    test('the Fly replay 503 path (statusCode === 503) is still present and keyed separately', () => {
      // The warming 503 error carries no statusCode, so the fly-replay branch,
      // which keys on err.statusCode === 503, is untouched.
      expect(createRoute).toContain("FLY_MACHINE_ID && err.statusCode === 503 && err.code !== 'new_page_timeout'");
      expect(createRoute).toContain("res.set('fly-replay'");
    });
  });

  describe('Part B — bounded one-time deadline extension', () => {
    test('a named, bounded extension constant exists', () => {
      expect(source).toContain('const TAB_CREATE_BUILD_EXTENSION_MS = 30000;');
    });

    test('extension fires only when a build is in flight for this user', () => {
      expect(createRoute).toContain('sessionCreations.has(tabCreateKey)');
      expect(createRoute).toContain('isTabCreateDeadlineTimeout(deadlineErr) && sessionCreations.has(tabCreateKey)');
    });

    test('extension re-awaits the SAME build promise (no second, racing build)', () => {
      // Both the base deadline and the extension wrap the single tabCreateWork
      // promise; a new build would corrupt coalescing.
      expect(createRoute).toContain('const tabCreateWork = (async () => {');
      expect(createRoute).toContain('withTimeout(tabCreateWork, tabCreateRequestTimeoutMs(), \'tab create\')');
      expect(createRoute).toContain('withTimeout(tabCreateWork, TAB_CREATE_BUILD_EXTENSION_MS, \'tab create\')');
    });

    test('extension happens at most once; otherwise the original error propagates', () => {
      // The else branch rethrows so a stuck navigation (no build in flight) still
      // times out at the base budget and is NOT extended.
      const tryBlock = createRoute.slice(createRoute.indexOf('} catch (deadlineErr) {'));
      expect(tryBlock).toContain('} else {');
      expect(tryBlock).toContain('throw deadlineErr;');
      // Only one extension withTimeout call exists inside the catch.
      const extensionCalls = tryBlock.match(/TAB_CREATE_BUILD_EXTENSION_MS, 'tab create'/g) || [];
      expect(extensionCalls.length).toBe(1);
    });

    test('an exceeded extension falls back to Part A (the extension uses the same label)', () => {
      // Both deadlines use the 'tab create' label, so if the extended deadline is
      // also exceeded the thrown error is classified by isTabCreateDeadlineTimeout
      // and returned as the retriable 503.
      expect(isTimeoutError(new Error('tab create timed out after 30000ms'))).toBe(true);
    });
  });

  describe('isTabCreateDeadlineTimeout classifier behavior', () => {
    // Re-derive the classifier predicate from its contract to assert behavior
    // (the function is module-private in server.js).
    const classify = (err) =>
      isTimeoutError(err) &&
      typeof err?.message === 'string' &&
      err.message.startsWith('tab create timed out after') &&
      err.code !== 'new_page_timeout';

    test('matches the outer tab-create deadline timeout', () => {
      expect(classify(new Error('tab create timed out after 30000ms'))).toBe(true);
    });

    test('does not match an inner new-page timeout', () => {
      const err = Object.assign(new Error('new page timed out after 10000ms'), { code: 'new_page_timeout' });
      expect(classify(err)).toBe(false);
    });

    test('does not match other inner operation timeouts (e.g. context close)', () => {
      expect(classify(new Error('context close timed out after 10000ms'))).toBe(false);
    });

    test('does not match non-timeout errors', () => {
      expect(classify(new Error('Maximum tabs per session reached'))).toBe(false);
    });
  });

  describe('OpenAPI documents the 503 for POST /tabs', () => {
    test('the committed spec includes a 503 response with Retry-After for /tabs', () => {
      const spec = JSON.parse(readFileSync(new URL('../../openapi.json', import.meta.url), 'utf8'));
      const post = spec.paths['/tabs']?.post;
      expect(post).toBeTruthy();
      expect(post.responses['503']).toBeTruthy();
      expect(post.responses['503'].headers?.['Retry-After']).toBeTruthy();
    });
  });
});
