/**
 * Tests for jo-browser navigate abort on tab deletion (P2 fix).
 *
 * Verifies:
 * 1. createTabState includes navigateAbort field
 * 2. navigateCurrentPage sets/clears AbortController
 * 3. DELETE /tabs/:tabId aborts in-flight navigation before closing page
 * 4. AbortController race rejects navigate when tab is deleted mid-flight
 */
import { describe, test, expect } from '@jest/globals';

// We can't import createTabState directly (not exported), so we test
// the behavior structurally by reading the source.
import { readFileSync } from 'fs';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const serverSource = readFileSync(resolve(__dirname, '../../server.js'), 'utf8');

describe('Navigate abort on tab deletion', () => {
  test('createTabState includes navigateAbort field', () => {
    // The createTabState function should initialise navigateAbort: null
    expect(serverSource).toContain('navigateAbort: null');
    const fnMatch = serverSource.match(/function createTabState\(page\)\s*\{[^}]+\}/s);
    expect(fnMatch).not.toBeNull();
    expect(fnMatch[0]).toContain('navigateAbort');
  });

  test('navigateCurrentPage creates AbortController and races goto', () => {
    // navigateCurrentPage should set tabState.navigateAbort = new AbortController()
    expect(serverSource).toContain('tabState.navigateAbort = new AbortController()');
    // Should use Promise.race with the abort signal
    expect(serverSource).toContain('Promise.race');
    expect(serverSource).toContain('Navigation aborted: tab deleted');
  });

  test('navigateCurrentPage clears navigateAbort in finally', () => {
    // After navigation completes (success or error), navigateAbort should be null
    const pattern = /tabState\.navigateAbort\s*=\s*null/;
    expect(pattern.test(serverSource)).toBe(true);
  });

  test('DELETE /tabs/:tabId aborts navigateAbort before page close', () => {
    // The delete handler should call .abort() on navigateAbort
    // Find the DELETE handler section
    const deleteSection = serverSource.slice(
      serverSource.indexOf("app.delete('/tabs/:tabId'"),
      serverSource.indexOf("app.delete('/tabs/:tabId'") + 800,
    );
    expect(deleteSection).toContain('navigateAbort');
    expect(deleteSection).toContain('.abort()');
    // abort() must come BEFORE safePageClose
    const abortIdx = deleteSection.indexOf('.abort()');
    const closeIdx = deleteSection.indexOf('safePageClose');
    expect(abortIdx).toBeLessThan(closeIdx);
  });

  test('AbortController race pattern rejects correctly', async () => {
    // Unit test the race pattern used in navigateCurrentPage
    const ac = new AbortController();

    const slowGoto = new Promise((resolve) => setTimeout(resolve, 10_000, 'done'));
    const abortP = new Promise((_, reject) => {
      ac.signal.addEventListener('abort', () => reject(new Error('Navigation aborted: tab deleted')), { once: true });
    });

    // Abort immediately
    setTimeout(() => ac.abort(), 5);

    await expect(Promise.race([slowGoto, abortP])).rejects.toThrow('Navigation aborted: tab deleted');
  });

  test('suppressed unhandled rejection on goto after abort', async () => {
    // Simulates the gotoP.catch(() => {}) pattern — no unhandled rejection
    const ac = new AbortController();

    let gotoReject;
    const gotoP = new Promise((_, reject) => { gotoReject = reject; });
    const abortP = new Promise((_, reject) => {
      ac.signal.addEventListener('abort', () => reject(new Error('Navigation aborted: tab deleted')), { once: true });
    });

    ac.abort();

    try {
      await Promise.race([gotoP, abortP]);
    } catch {
      gotoP.catch(() => {}); // suppress — mirrors production code
    }

    // Now reject the goto (simulates page.close killing in-flight navigation)
    gotoReject(new Error('page closed'));
    // If catch suppression works, no unhandled rejection is thrown
    await new Promise((r) => setTimeout(r, 50));
  });
});
