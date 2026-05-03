/**
 * Unit tests for safePageClose (BugHunter#174).
 *
 * Covers:
 * 1. Happy path: page closes within timeout — no force-close triggered
 * 2. Timeout path: hung page.close() causes force-close + removeAllListeners
 * 3. Already-closed page is a no-op (isClosed guard)
 * 4. null page is a no-op
 */
import { describe, test, expect, jest } from '@jest/globals';
import { readFileSync } from 'fs';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const serverSource = readFileSync(resolve(__dirname, '../../server.js'), 'utf8');

// Re-implement safePageClose inline from the source so we can inject mocks
// without importing the full server (which starts a browser).
function buildSafePageClose({ log = () => {}, PAGE_CLOSE_TIMEOUT_MS = 100 } = {}) {
  return async function safePageClose(page) {
    if (!page || page.isClosed()) return;
    try {
      await Promise.race([
        page.close({ runBeforeUnload: false }),
        new Promise((_, rej) => setTimeout(() => rej(new Error('page close timed out')), PAGE_CLOSE_TIMEOUT_MS)),
      ]);
    } catch (e) {
      log('warn', 'page close timed out, force-closing', { error: e.message });
      try { await page.close({ runBeforeUnload: false }); } catch (_) {}
      page.removeAllListeners();
    }
  };
}

describe('safePageClose — source shape', () => {
  test('uses runBeforeUnload: false in primary close call', () => {
    expect(serverSource).toContain("page.close({ runBeforeUnload: false })");
  });

  test('rejects on timeout (not resolves)', () => {
    expect(serverSource).toContain("page close timed out");
    // The timeout branch must use reject, not resolve
    const fnStart = serverSource.indexOf('async function safePageClose');
    const fnEnd = serverSource.indexOf('\n}', fnStart) + 2;
    const fn = serverSource.slice(fnStart, fnEnd);
    expect(fn).toContain('rej(');
    expect(fn).not.toMatch(/new Promise\(\s*resolve\s*=>/);
  });

  test('calls removeAllListeners in catch block', () => {
    const fnStart = serverSource.indexOf('async function safePageClose');
    const fnEnd = serverSource.indexOf('\n}', fnStart) + 2;
    const fn = serverSource.slice(fnStart, fnEnd);
    expect(fn).toContain('page.removeAllListeners()');
  });

  test('guards against null/closed page', () => {
    const fnStart = serverSource.indexOf('async function safePageClose');
    const fnEnd = serverSource.indexOf('\n}', fnStart) + 2;
    const fn = serverSource.slice(fnStart, fnEnd);
    expect(fn).toContain('page.isClosed()');
  });
});

describe('safePageClose — behaviour', () => {
  test('happy path: closes successfully within timeout', async () => {
    const calls = [];
    const page = {
      isClosed: () => false,
      close: jest.fn(async () => { calls.push('close'); }),
      removeAllListeners: jest.fn(),
    };

    const logs = [];
    const safePageClose = buildSafePageClose({ log: (...a) => logs.push(a), PAGE_CLOSE_TIMEOUT_MS: 200 });
    await safePageClose(page);

    expect(page.close).toHaveBeenCalledTimes(1);
    expect(page.removeAllListeners).not.toHaveBeenCalled();
    expect(logs).toHaveLength(0);
  });

  test('timeout path: force-closes and removes listeners when primary close hangs', async () => {
    let callCount = 0;
    const page = {
      isClosed: () => false,
      // First call (primary): never resolves to simulate hang.
      // Second call (force-close): resolves immediately.
      close: jest.fn(() => {
        callCount++;
        if (callCount === 1) return new Promise(() => {});
        return Promise.resolve();
      }),
      removeAllListeners: jest.fn(),
    };

    const logs = [];
    const safePageClose = buildSafePageClose({ log: (...a) => logs.push(a), PAGE_CLOSE_TIMEOUT_MS: 50 });
    await safePageClose(page);

    // close() called twice: once in race, once in force-close catch
    expect(page.close).toHaveBeenCalledTimes(2);
    expect(page.removeAllListeners).toHaveBeenCalledTimes(1);
    expect(logs[0][0]).toBe('warn');
    expect(logs[0][1]).toContain('timed out');
  }, 10_000);

  test('already-closed page is skipped entirely', async () => {
    const page = {
      isClosed: () => true,
      close: jest.fn(),
      removeAllListeners: jest.fn(),
    };

    const safePageClose = buildSafePageClose({ PAGE_CLOSE_TIMEOUT_MS: 50 });
    await safePageClose(page);

    expect(page.close).not.toHaveBeenCalled();
    expect(page.removeAllListeners).not.toHaveBeenCalled();
  });

  test('null page is a no-op', async () => {
    const safePageClose = buildSafePageClose({ PAGE_CLOSE_TIMEOUT_MS: 50 });
    await expect(safePageClose(null)).resolves.toBeUndefined();
  });
});
