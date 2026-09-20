import { jest } from '@jest/globals';
import {
  applyPersistentProfilePrefs,
  closePagePreservingPersistentContext,
  probeBrowserHealth,
  wrapPersistentContext,
} from '../../lib/persistent-context.js';

function makeContext({ pages = [] } = {}) {
  return {
    browser: jest.fn(() => ({
      isConnected: jest.fn(() => true),
      process: jest.fn(() => ({ pid: 1234 })),
    })),
    pages: jest.fn(() => pages),
    newPage: jest.fn(),
    close: jest.fn(async () => {}),
  };
}

describe('persistent browser context lifecycle', () => {
  test('applies durable Firefox session-cookie preferences without losing Camoufox prefs', () => {
    const options = applyPersistentProfilePrefs({
      firefoxUserPrefs: { 'webgl.force-enabled': true, 'privacy.sanitize.sanitizeOnShutdown': true },
    });

    expect(options.firefoxUserPrefs['webgl.force-enabled']).toBe(true);
    expect(options.firefoxUserPrefs['browser.startup.page']).toBe(3);
    expect(options.firefoxUserPrefs['browser.sessionstore.privacy_level']).toBe(0);
    expect(options.firefoxUserPrefs['browser.sessionstore.resume_session_once']).toBe(true);
    expect(options.firefoxUserPrefs['privacy.sanitize.sanitizeOnShutdown']).toBe(false);
    expect(options.firefoxUserPrefs['privacy.clearOnShutdown.cookies']).toBe(false);
    expect(options.firefoxUserPrefs['privacy.clearOnShutdown_v2.cookiesAndStorage']).toBe(false);
  });

  test('session lease close never closes the shared persistent context', async () => {
    const context = makeContext();
    const browser = wrapPersistentContext(context);

    const lease = await browser.newContext();
    await lease.close();

    expect(context.close).not.toHaveBeenCalled();
    await browser.close();
    expect(context.close).toHaveBeenCalledTimes(1);
  });

  test('persistent adapter rejects silently ignored per-session options', async () => {
    const browser = wrapPersistentContext(makeContext());
    await expect(browser.newContext({ storageState: '/ignored.json' }))
      .rejects.toThrow(/Per-session BrowserContext options are unsupported/);
  });

  test('health probe uses an existing persistent page without navigation or context close', async () => {
    const page = {
      isClosed: jest.fn(() => false),
      evaluate: jest.fn(async () => true),
      goto: jest.fn(),
      close: jest.fn(),
    };
    const context = makeContext({ pages: [page] });
    const browser = wrapPersistentContext(context);

    await probeBrowserHealth(browser, { timeoutMs: 5000 });

    expect(page.evaluate).toHaveBeenCalledTimes(1);
    expect(page.goto).not.toHaveBeenCalled();
    expect(page.close).not.toHaveBeenCalled();
    expect(context.newPage).not.toHaveBeenCalled();
    expect(context.close).not.toHaveBeenCalled();
  });

  test('health probe retains a page when persistent context has no pages', async () => {
    const page = {
      isClosed: jest.fn(() => false),
      evaluate: jest.fn(async () => true),
      goto: jest.fn(),
      close: jest.fn(async () => {}),
    };
    const context = makeContext();
    context.newPage.mockResolvedValue(page);
    const browser = wrapPersistentContext(context);

    await probeBrowserHealth(browser, { timeoutMs: 5000 });

    expect(context.newPage).toHaveBeenCalledTimes(1);
    expect(page.evaluate).toHaveBeenCalledTimes(1);
    expect(page.goto).not.toHaveBeenCalled();
    expect(page.close).not.toHaveBeenCalled();
    expect(context.close).not.toHaveBeenCalled();
  });

  test('closing the final persistent page retains it as about:blank', async () => {
    const pages = [];
    const context = makeContext({ pages });
    const page = {
      context: jest.fn(() => context),
      isClosed: jest.fn(() => false),
      url: jest.fn(() => 'https://example.com/'),
      goto: jest.fn(async () => {}),
      removeAllListeners: jest.fn(),
    };
    pages.push(page);
    wrapPersistentContext(context);
    const closePage = jest.fn(async () => {});

    const result = await closePagePreservingPersistentContext(page, closePage);

    expect(result).toEqual({ closed: false, retained: true });
    expect(page.goto).toHaveBeenCalledWith('about:blank', expect.objectContaining({ waitUntil: 'commit' }));
    expect(closePage).not.toHaveBeenCalled();
  });

  test('closing a persistent page normally when another page remains', async () => {
    const pages = [];
    const context = makeContext({ pages });
    const page = {
      context: jest.fn(() => context),
      isClosed: jest.fn(() => false),
      url: jest.fn(() => 'https://example.com/'),
    };
    const survivor = { isClosed: jest.fn(() => false) };
    pages.push(page, survivor);
    wrapPersistentContext(context);
    const closePage = jest.fn(async () => {});

    const result = await closePagePreservingPersistentContext(page, closePage);

    expect(result).toEqual({ closed: true, retained: false });
    expect(closePage).toHaveBeenCalledTimes(1);
  });

  test('health probe still uses a disposable context for normal browsers', async () => {
    const page = {
      goto: jest.fn(async () => {}),
      close: jest.fn(async () => {}),
    };
    const context = makeContext();
    context.newPage.mockResolvedValue(page);
    const browser = {
      newContext: jest.fn(async () => context),
    };

    await probeBrowserHealth(browser, { timeoutMs: 5000 });

    expect(browser.newContext).toHaveBeenCalledTimes(1);
    expect(page.goto).toHaveBeenCalledWith('about:blank', { timeout: 5000 });
    expect(page.close).toHaveBeenCalledTimes(1);
    expect(context.close).toHaveBeenCalledTimes(1);
  });
});
