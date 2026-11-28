/**
 * Tests for the /click guard against retrying a click that already navigated.
 *
 * Regression: a click that starts a navigation slower than the click's 3s
 * timeout is reported by Playwright as a timeout. The handler then ran its
 * force / DOM / mouse-sequence fallbacks, which clicked again: a second form
 * submit, or a click on whatever sat at that spot on the next page.
 *
 * The fix checks whether the page URL changed since the click started
 * (waiting up to 1s, bounded by the remaining budget, for a committed
 * navigation) before any fallback, and treats the click as done if it did.
 */
import { describe, test, expect } from '@jest/globals';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { createNavigationCheck } from '../../lib/click-navigation.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const serverSrc = readFileSync(join(__dirname, '../../server.js'), 'utf8');

function fakePage(url, { commitTo = null, commitAfterMs = 0 } = {}) {
  const page = {
    current: url,
    waits: [],
    url() { return page.current; },
    waitForURL(predicate, options) {
      page.waits.push(options);
      if (commitTo !== null && commitAfterMs <= options.timeout) {
        page.current = commitTo;
        if (predicate(new URL(commitTo))) return Promise.resolve();
      }
      return Promise.reject(new Error(`page.waitForURL: Timeout ${options.timeout}ms exceeded.`));
    },
  };
  return page;
}

describe('createNavigationCheck', () => {
  test('a URL that already changed counts as navigated without waiting', async () => {
    const page = fakePage('https://a.example/');
    const navigated = createNavigationCheck(page);
    page.current = 'https://b.example/';
    await expect(navigated(1000)).resolves.toBe(true);
    expect(page.waits).toHaveLength(0);
  });

  test('a navigation that commits within the wait counts as navigated', async () => {
    const page = fakePage('https://a.example/', { commitTo: 'https://b.example/', commitAfterMs: 400 });
    const navigated = createNavigationCheck(page);
    await expect(navigated(1000)).resolves.toBe(true);
    expect(page.waits).toEqual([{ timeout: 1000, waitUntil: 'commit' }]);
  });

  test('no navigation means the click did not take effect', async () => {
    const page = fakePage('https://a.example/');
    const navigated = createNavigationCheck(page);
    await expect(navigated(1000)).resolves.toBe(false);
  });

  test('no budget left: checks the URL but does not wait', async () => {
    const page = fakePage('https://a.example/', { commitTo: 'https://b.example/' });
    const navigated = createNavigationCheck(page);
    await expect(navigated(0)).resolves.toBe(false);
    expect(page.waits).toHaveLength(0);
  });

  test('the URL is taken when the check is created, before the click', async () => {
    const page = fakePage('https://a.example/');
    const navigated = createNavigationCheck(page);
    page.current = 'https://a.example/#section';
    await expect(navigated(1000)).resolves.toBe(true);
  });
});

describe('/click handler wiring', () => {
  const start = serverSrc.indexOf('const doClick = async (locatorOrSelector, isLocator) => {');
  const body = serverSrc.slice(start, serverSrc.indexOf('\n      };', start));

  test('the check is created before the first click attempt', () => {
    expect(start).toBeGreaterThan(-1);
    const created = body.indexOf('createNavigationCheck(tabState.page)');
    expect(created).toBeGreaterThan(-1);
    expect(created).toBeLessThan(body.indexOf('await click({'));
  });

  test('every catch checks for navigation before its fallback', () => {
    const catches = body.match(/catch \((err|forceErr)\) \{\s*if \(await clickNavigated\(\1\)\) return;/g) || [];
    expect(catches).toHaveLength(4);
    expect(body.match(/catch \(/g)).toHaveLength(4);
  });

  test('the wait is bounded by the remaining budget', () => {
    expect(body).toMatch(/navigatedSinceClick\(Math\.min\(1000, remainingBudget\(\)\)\)/);
  });
});
