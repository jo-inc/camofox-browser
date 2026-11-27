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

function runInOrigin(fn, arg, entries) {
  const store = new Map();
  const localStorage = {
    clear: () => store.clear(),
    setItem: (name, value) => store.set(name, String(value)),
  };
  const before = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  Object.defineProperty(globalThis, 'localStorage', { value: localStorage, configurable: true, writable: true });
  try {
    for (const [name, value] of entries || []) store.set(name, value);
    fn(arg);
  } finally {
    if (before) Object.defineProperty(globalThis, 'localStorage', before);
    else delete globalThis.localStorage;
  }
  return [...store].map(([name, value]) => ({ name, value }));
}

// Models uBlock Origin cancelling the restore navigation to a blocked origin, and its block page then aborting the
// next navigation in that tab, so Playwright's error can name the wrong origin.
function fakeBrowser(blocked, { redirects = {} } = {}) {
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
      const storage = new Map();
      const pages = [];
      const context = {
        options,
        storage,
        pages,
        route: jest.fn(async () => {}),
        close: jest.fn(async () => {}),
        newPage: jest.fn(async () => {
          let url = 'about:blank';
          let onBlockPage = false;
          const page = {
            route: jest.fn(async () => {}),
            goto: jest.fn(async (target) => {
              if (onBlockPage) {
                onBlockPage = false;
                throw new Error('page.goto: NS_BINDING_ABORTED');
              }
              const origin = new URL(target).origin;
              if (blocked.includes(origin)) {
                onBlockPage = true;
                throw new Error('page.goto: NS_ERROR_ABORT');
              }
              url = redirects[origin] || new URL(target).href;
            }),
            url: () => url,
            evaluate: jest.fn(async (fn, arg) => {
              const origin = new URL(url).origin;
              storage.set(origin, runInOrigin(fn, arg, storage.get(origin)?.map((e) => [e.name, e.value])));
            }),
            close: jest.fn(async () => {}),
          };
          pages.push(page);
          return page;
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
  .map((origin, i) => ({ origin, localStorage: [{ name: 'k', value: 'v' + i }, { name: 'n', value: String(i) }] }));
const blocked = ['https://7.html-load.com', 'https://6.stg.html-load.com'];
const restored = (context) => Object.fromEntries([...context.storage].map(([origin, entries]) => [origin, entries]));

describe('newContextRestoringStorage', () => {
  test('restores localStorage itself on one stubbed page, so Playwright does not visit every saved origin', async () => {
    const browser = fakeBrowser([]);
    const log = jest.fn();
    const context = await newContextRestoringStorage(browser, { viewport: null, storageState: { cookies, origins } }, { userId: 'u', log });

    expect(browser.newContext).toHaveBeenCalledTimes(1);
    expect(context.options.viewport).toBeNull();
    expect(context.options.storageState).toEqual({ cookies, origins: [] });
    expect(restored(context)).toEqual(Object.fromEntries(origins.map((o) => [o.origin, o.localStorage])));
    expect(context.pages).toHaveLength(1);
    expect(context.pages[0].route).toHaveBeenCalledWith('**/*', expect.any(Function));
    expect(context.pages[0].close).toHaveBeenCalled();
    expect(log).not.toHaveBeenCalled();
  });

  test('the page-side write replaces what the origin held with the saved entries', async () => {
    const browser = fakeBrowser([]);
    const context = await browser.newContext();
    context.storage.set('https://example.com', [{ name: 'stale', value: 'x' }]);
    browser.newContext.mockResolvedValueOnce(context);
    await newContextRestoringStorage(browser, { storageState: { cookies, origins: origins.slice(0, 1) } }, { userId: 'u', log: jest.fn() });
    expect(context.storage.get('https://example.com')).toEqual(origins[0].localStorage);
  });

  test('drops the origins an extension blocks, keeping every cookie and the origin its block page spilt onto', async () => {
    const browser = fakeBrowser(blocked);
    const log = jest.fn();
    const context = await newContextRestoringStorage(browser, { viewport: null, storageState: { cookies, origins } }, { userId: 'u', log });

    expect(browser.newContext).toHaveBeenCalledTimes(2);
    expect(browser.contexts[0].close).toHaveBeenCalled();
    expect(context).toBe(browser.contexts[1]);
    expect(context.close).not.toHaveBeenCalled();
    expect(context.pages).toHaveLength(1);
    expect(context.options.viewport).toBeNull();
    expect(context.options.storageState.cookies).toEqual(cookies);
    expect(Object.keys(restored(context))).toEqual(['https://example.com', 'https://www.wikipedia.org', 'https://example.org']);
    expect(context.storage.get('https://www.wikipedia.org')).toEqual(origins[2].localStorage);
    expect(log).toHaveBeenCalledWith('warn', 'storage state restore: dropped the origins that cannot be restored', {
      userId: 'u',
      dropped: [
        { origin: 'https://7.html-load.com', error: 'page.goto: NS_ERROR_ABORT' },
        { origin: 'https://6.stg.html-load.com', error: 'page.goto: NS_ERROR_ABORT' },
      ],
      kept: 3,
    });
    for (const page of browser.contexts[0].pages) expect(page.close).toHaveBeenCalled();
    expect(browser.contexts[0].pages.length).toBeGreaterThan(1);
  });

  test('an origin that only failed because the page was on a block page still forces a clean rebuild', async () => {
    const browser = fakeBrowser([]);
    const first = await browser.newContext();
    const realNewPage = first.newPage.getMockImplementation();
    let opened = 0;
    first.newPage.mockImplementation(async () => {
      const page = await realNewPage();
      // The first page's first navigation is aborted, as if by an earlier block page; the retry on a fresh page works.
      if (opened++ === 0) page.goto.mockRejectedValueOnce(new Error('page.goto: NS_BINDING_ABORTED'));
      return page;
    });
    browser.newContext.mockResolvedValueOnce(first);
    const log = jest.fn();
    const context = await newContextRestoringStorage(browser, { storageState: { cookies, origins } }, { userId: 'u', log });
    expect(first.close).toHaveBeenCalled();
    expect(context).not.toBe(first);
    expect(Object.keys(restored(context))).toHaveLength(origins.length);
    expect(log).not.toHaveBeenCalled();
  });

  test('an origin that passes once and fails on the rebuild is dropped then (uBlock blocks nothing until its lists load)', async () => {
    const browser = fakeBrowser(['https://7.html-load.com']);
    const real = browser.newContext.getMockImplementation();
    let calls = 0;
    browser.newContext.mockImplementation(async (options) => {
      const context = await real(options);
      if (++calls >= 2) {
        const realNewPage = context.newPage.getMockImplementation();
        context.newPage.mockImplementation(async () => {
          const page = await realNewPage();
          const realGoto = page.goto.getMockImplementation();
          page.goto.mockImplementation(async (target) => {
            if (new URL(target).origin === 'https://example.org') throw new Error('page.goto: NS_ERROR_NET_RESET');
            return realGoto(target);
          });
          return page;
        });
      }
      return context;
    });
    const log = jest.fn();
    const context = await newContextRestoringStorage(browser, { storageState: { cookies, origins } }, { userId: 'u', log });
    expect(browser.newContext).toHaveBeenCalledTimes(3);
    expect(Object.keys(restored(context))).toEqual(['https://example.com', 'https://www.wikipedia.org', 'https://6.stg.html-load.com']);
    expect(log).toHaveBeenCalledWith('warn', 'storage state restore: dropped the origins that cannot be restored', expect.objectContaining({
      dropped: [
        { origin: 'https://7.html-load.com', error: 'page.goto: NS_ERROR_ABORT' },
        { origin: 'https://example.org', error: 'page.goto: NS_ERROR_NET_RESET' },
      ],
      kept: 3,
    }));
  });

  test('a restore that never completes cleanly is an error, not a context left to fail every checkpoint', async () => {
    const browser = fakeBrowser([]);
    const real = browser.newContext.getMockImplementation();
    browser.newContext.mockImplementation(async (options) => {
      const context = await real(options);
      const realNewPage = context.newPage.getMockImplementation();
      let opened = 0;
      context.newPage.mockImplementation(async () => {
        const page = await realNewPage();
        // Every pass, the first navigation on the first page is aborted and its retry works.
        if (opened++ === 0) page.goto.mockRejectedValueOnce(new Error('page.goto: NS_BINDING_ABORTED'));
        return page;
      });
      return context;
    });
    await expect(newContextRestoringStorage(browser, { storageState: { cookies, origins } }, { userId: 'u', log: jest.fn() }))
      .rejects.toThrow('storage state restore did not complete cleanly in 3 passes: an origin that failed once');
    expect(browser.contexts).toHaveLength(3);
    for (const context of browser.contexts) expect(context.close).toHaveBeenCalled();
  });

  test('an origin whose stubbed navigation lands on another origin is dropped, not written there', async () => {
    const browser = fakeBrowser([], { redirects: { 'https://example.org': 'https://example.net/' } });
    const log = jest.fn();
    const context = await newContextRestoringStorage(browser, { storageState: { cookies, origins } }, { userId: 'u', log });
    expect(context.storage.has('https://example.net')).toBe(false);
    expect(context.storage.has('https://example.org')).toBe(false);
    expect(log).toHaveBeenCalledWith('warn', expect.any(String), expect.objectContaining({
      dropped: [{ origin: 'https://example.org', error: 'landed on https://example.net' }],
      kept: 4,
    }));
    expect(browser.newContext).toHaveBeenCalledTimes(2);
  });

  test('origins with nothing in localStorage are not visited', async () => {
    const browser = fakeBrowser([]);
    const empty = [{ origin: 'https://example.com', localStorage: [] }, { origin: 'https://example.org' }];
    const context = await newContextRestoringStorage(browser, { storageState: { cookies, origins: empty } }, { userId: 'u', log: jest.fn() });
    expect(context.newPage).not.toHaveBeenCalled();
    expect(context.options.storageState).toEqual({ cookies, origins: [] });
  });

  test('reads a storage state given as a path, as the persistence plugin passes it', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'storage-restore-'));
    const file = path.join(dir, 'storage-state.json');
    await fs.writeFile(file, JSON.stringify({ cookies, origins }));
    try {
      const browser = fakeBrowser(blocked);
      const context = await newContextRestoringStorage(browser, { storageState: file }, { userId: 'u', log: jest.fn() });
      expect(context.options.storageState.cookies).toEqual(cookies);
      expect(Object.keys(restored(context))).toHaveLength(3);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  test('origins holding IndexedDB stay with Playwright, which restores it', async () => {
    const browser = fakeBrowser([]);
    const idb = { origin: 'https://app.example', localStorage: [{ name: 'a', value: '1' }], indexedDB: [{ name: 'db', version: 1, stores: [] }] };
    const context = await newContextRestoringStorage(browser, { storageState: { cookies, origins: [idb, origins[0], origins[2]] } }, { userId: 'u', log: jest.fn() });
    expect(context.options.storageState.origins).toEqual([idb]);
    expect(Object.keys(restored(context))).toEqual(['https://example.com', 'https://www.wikipedia.org']);
  });

  test("an IndexedDB origin Playwright cannot restore is dropped and newContext retried, as before", async () => {
    const browser = fakeBrowser(['https://7.html-load.com']);
    const log = jest.fn();
    const withIdb = (o) => ({ ...o, indexedDB: [{ name: 'db', version: 1, stores: [] }] });
    const state = { cookies, origins: origins.slice(0, 3).map(withIdb) };
    const context = await newContextRestoringStorage(browser, { storageState: state }, { userId: 'u', log });
    expect(context.options.storageState.origins.map((o) => o.origin)).toEqual(['https://example.com', 'https://www.wikipedia.org']);
    expect(log).toHaveBeenCalledWith('warn', 'storage state restore failed; restoring without the origins that cannot be restored', expect.objectContaining({
      dropped: [{ origin: 'https://7.html-load.com', error: 'page.goto: NS_ERROR_ABORT' }],
      kept: 2,
    }));
  });

  test('a failure that is not one origin\'s closes the context and is rethrown', async () => {
    const browser = fakeBrowser([]);
    const context = await browser.newContext();
    context.newPage.mockRejectedValue(new Error('browserContext.newPage: Target page, context or browser has been closed'));
    browser.newContext.mockResolvedValueOnce(context);
    await expect(newContextRestoringStorage(browser, { storageState: { cookies, origins } }, { userId: 'u', log: jest.fn() }))
      .rejects.toThrow('has been closed');
    expect(context.close).toHaveBeenCalled();
  });

  test('without a storage state, newContext gets the options as given', async () => {
    const browser = fakeBrowser([]);
    const options = { viewport: null };
    const context = await newContextRestoringStorage(browser, options, { userId: 'u', log: jest.fn() });
    expect(context.options).toBe(options);
  });

  test('an error from newContext itself is rethrown', async () => {
    const browser = { newContext: jest.fn().mockRejectedValue(new Error('Target page, context or browser has been closed')) };
    await expect(newContextRestoringStorage(browser, { storageState: { cookies, origins } }, { userId: 'u', log: jest.fn() }))
      .rejects.toThrow('has been closed');
    expect(browser.newContext).toHaveBeenCalledTimes(1);
  });
});
