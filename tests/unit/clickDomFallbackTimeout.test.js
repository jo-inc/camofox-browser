/**
 * Tests for the bounded locator.evaluate() call in the /click DOM-click fallback.
 *
 * Same failure as clickBoundingBoxTimeout.test.js, one step earlier: when the
 * force click failed, dispatchDomClick called locator.evaluate() with no
 * timeout. For an element that no longer resolves, Playwright waited its
 * default 30s, which used up HANDLER_TIMEOUT_MS before the mouse-sequence
 * fallback (and its bounded boundingBox) could run, and the tab was destroyed.
 *
 * The fix bounds evaluate() to min(3s, remaining budget), floored at 500ms,
 * so a failure falls through to dispatchMouseSequence and its 422.
 */
import { describe, test, expect } from '@jest/globals';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const serverSrc = readFileSync(join(__dirname, '../../server.js'), 'utf8');

function dispatchDomClickSource() {
  const start = serverSrc.indexOf('const dispatchDomClick = async (locator) => {');
  expect(start).toBeGreaterThan(-1);
  const end = serverSrc.indexOf('\n      };', start);
  expect(end).toBeGreaterThan(start);
  return serverSrc.slice(start, end);
}

describe('/click DOM-click fallback evaluate bounding', () => {
  test('evaluate() in dispatchDomClick is called with an explicit timeout', () => {
    const src = dispatchDomClickSource();
    expect(src).toMatch(/const timeout = Math\.max\(500, Math\.min\(3000, remainingBudget\(\)\)\);/);
    expect(src).toMatch(/\}, undefined, \{ timeout \}\);/);
  });

  test('a failed DOM click still falls through to the mouse sequence', () => {
    const start = serverSrc.indexOf('const recoverForceClickFailure = async (locator) => {');
    expect(start).toBeGreaterThan(-1);
    const body = serverSrc.slice(start, start + 400);
    expect(body).toMatch(/await dispatchDomClick\(locator\);\s*\} catch \(domErr\) \{/);
    expect(body).toMatch(/await dispatchMouseSequence\(locator\);/);
  });
});
