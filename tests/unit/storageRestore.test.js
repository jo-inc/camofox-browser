import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, jest, test } from '@jest/globals';
import { newContextRestoringStorage } from '../../lib/storage-restore.js';

// Playwright's own wording: setStorageState rewrites whatever the restore navigation threw.
function restoreError(cause, navigated) {
  const calls = navigated.map((o) => `  - navigating to "${o}", waiting until "load"`).join('\n');
  return new Error(`browser.newContext: Error setting storage state:\n${cause}\nCall log:\n${calls}\n`);
}

// Models uBlock Origin cancelling the restore navigation to a blocked origin, and its block page then aborting the
// next origin's navigation, so Playwright's error can name the wrong origin.
function fakeBrowser(blocked) {
  const contexts = [];
  const browser = {
    contexts,
    newContext: jest.fn(async (options = {}) => {
      const state = options.storageState;
      if (state) {
        const origins = (typeof state === 'string' ? JSON.parse(await fs.readFile(state, 'utf8')) : state).origins || [];
        const hit = origins.findIndex((o) => blocked.includes(o.origin));
        if (hit >= 0) {
          const navigated = origins.slice(0, Math.min(hit + 2, origins.length)).map((o) => o.origin);
          throw restoreError('NS_BINDING_ABORTED', navigated);
        }
      }
      const context = {
        options,
        route: jest.fn(async () => {}),
        close: jest.fn(async () => {}),
        newPage: jest.fn(async () => {
          let url = 'about:blank';
          return {
            goto: jest.fn(async (target) => {
              if (blocked.includes(new URL(target).origin)) throw new Error('page.goto: NS_ERROR_ABORT');
              url = new URL(target).href;
            }),
            url: () => url,
            close: jest.fn(async () => {}),
          };
        }),
      };
      contexts.push(context);
      return context;
    }),
  };
  return browser;
}

const cookies = [{ name: 'sid', value: 'secret', domain: 'example.com', path: '/', expires: -1, httpOnly: true, secure: true, sameSite: 'Lax' }];
const origins = ['https://example.com', 'https://7.html-load.com', 'https://www.wikipedia.org', 'https://6.stg.html-load.com', 'https://example.org']
  .map((origin, i) => ({ origin, localStorage: [{ name: 'k', value: 'v' + i }] }));
const blocked = ['https://7.html-load.com', 'https://6.stg.html-load.com'];

describe('newContextRestoringStorage', () => {
  test('restores without the origins whose restore navigation an extension blocks, keeping every cookie', async () => {
    const browser = fakeBrowser(blocked);
    const log = jest.fn();
    const context = await newContextRestoringStorage(browser, { viewport: null, storageState: { cookies, origins } }, { userId: 'agentic-human', log });

    expect(context.options.viewport).toBeNull();
    expect(context.options.storageState.cookies).toEqual(cookies);
    expect(context.options.storageState.origins.map((o) => o.origin)).toEqual(['https://example.com', 'https://www.wikipedia.org', 'https://example.org']);
    expect(context.options.storageState.origins[1].localStorage).toEqual([{ name: 'k', value: 'v2' }]);
    expect(log).toHaveBeenCalledWith('warn', 'storage state restore failed; restoring without the origins that cannot be restored', expect.objectContaining({
      userId: 'agentic-human',
      error: 'NS_BINDING_ABORTED',
      dropped: [
        { origin: 'https://7.html-load.com', error: 'page.goto: NS_ERROR_ABORT' },
        { origin: 'https://6.stg.html-load.com', error: 'page.goto: NS_ERROR_ABORT' },
      ],
      kept: 3,
    }));
    const probe = browser.contexts[0];
    expect(probe.options.storageState).toBeUndefined();
    expect(probe.route).toHaveBeenCalledWith('**/*', expect.any(Function));
    expect(probe.close).toHaveBeenCalled();
  });

  test('reads a storage state given as a path, as the persistence plugin passes it', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'storage-restore-'));
    const file = path.join(dir, 'storage-state.json');
    await fs.writeFile(file, JSON.stringify({ cookies, origins }));
    try {
      const browser = fakeBrowser(blocked);
      const context = await newContextRestoringStorage(browser, { storageState: file }, { userId: 'u', log: jest.fn() });
      expect(context.options.storageState.cookies).toEqual(cookies);
      expect(context.options.storageState.origins).toHaveLength(3);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  test('a restore that succeeds is untouched', async () => {
    const browser = fakeBrowser([]);
    const log = jest.fn();
    const options = { storageState: { cookies, origins } };
    const context = await newContextRestoringStorage(browser, options, { userId: 'u', log });
    expect(browser.newContext).toHaveBeenCalledTimes(1);
    expect(context.options).toBe(options);
    expect(log).not.toHaveBeenCalled();
  });

  test('an error that is not a storage-state restore is rethrown without a probe', async () => {
    const browser = { newContext: jest.fn().mockRejectedValue(new Error('Target page, context or browser has been closed')) };
    await expect(newContextRestoringStorage(browser, { storageState: { cookies, origins } }, { userId: 'u', log: jest.fn() }))
      .rejects.toThrow('has been closed');
    expect(browser.newContext).toHaveBeenCalledTimes(1);
  });

  test('when no origin fails on its own, the original error stands and no state is dropped', async () => {
    const browser = fakeBrowser([]);
    const original = restoreError('Timeout 30000ms exceeded.', ['https://example.com']);
    browser.newContext.mockRejectedValueOnce(original);
    await expect(newContextRestoringStorage(browser, { storageState: { cookies, origins } }, { userId: 'u', log: jest.fn() }))
      .rejects.toBe(original);
    expect(browser.newContext).toHaveBeenCalledTimes(2);
  });

  test('a retry that fails too is reported, not papered over with a cookies-only context', async () => {
    const browser = fakeBrowser(['https://7.html-load.com']);
    const real = browser.newContext.getMockImplementation();
    let calls = 0;
    browser.newContext.mockImplementation(async (options) => {
      calls += 1;
      if (calls === 3) throw restoreError('NS_ERROR_FAILURE', ['https://example.com']);
      return real(options);
    });
    await expect(newContextRestoringStorage(browser, { storageState: { cookies, origins } }, { userId: 'u', log: jest.fn() }))
      .rejects.toThrow('NS_ERROR_FAILURE');
  });
});
