/**
 * Unit tests for the viewport transport shim.
 *
 * Playwright 1.62's Firefox driver adds `isMobile` / `screenSize` fields to the
 * Juggler `Page.setViewportSize` and `Browser.setDefaultViewport` messages that
 * Camoufox 152 rejects. `stripViewportFields` removes exactly those fields
 * without mutating the caller's object. `installViewportTransportShim` reaches
 * the live transport defensively and wraps its `send` exactly once.
 */
import { describe, test, expect, jest } from '@jest/globals';
import {
  stripViewportFields,
  installViewportTransportShim,
} from '../../lib/viewport-transport-shim.js';

describe('stripViewportFields', () => {
  test('Page.setViewportSize strips screenSize + isMobile, preserves width/height', () => {
    const input = {
      id: 13,
      method: 'Page.setViewportSize',
      sessionId: 'abc',
      params: {
        viewportSize: { width: 1024, height: 768 },
        screenSize: { width: 1024, height: 768 },
        isMobile: false,
      },
    };
    const out = stripViewportFields(input);
    expect(out.params).toEqual({ viewportSize: { width: 1024, height: 768 } });
    expect(out.params.screenSize).toBeUndefined();
    expect(out.params.isMobile).toBeUndefined();
    // Non-params fields preserved.
    expect(out.id).toBe(13);
    expect(out.method).toBe('Page.setViewportSize');
    expect(out.sessionId).toBe('abc');
  });

  test('Page.setViewportSize does not mutate the caller object', () => {
    const input = {
      method: 'Page.setViewportSize',
      params: {
        viewportSize: { width: 800, height: 600 },
        screenSize: { width: 800, height: 600 },
        isMobile: true,
      },
    };
    const snapshot = JSON.parse(JSON.stringify(input));
    stripViewportFields(input);
    expect(input).toEqual(snapshot);
  });

  test('Browser.setDefaultViewport strips nested viewport.screenSize + viewport.isMobile', () => {
    const input = {
      id: 6,
      method: 'Browser.setDefaultViewport',
      params: {
        browserContextId: 'ctx-1',
        viewport: {
          viewportSize: { width: 800, height: 600 },
          deviceScaleFactor: 2,
          screenSize: { width: 800, height: 600 },
          isMobile: false,
        },
      },
    };
    const out = stripViewportFields(input);
    expect(out.params.viewport).toEqual({
      viewportSize: { width: 800, height: 600 },
      deviceScaleFactor: 2,
    });
    expect(out.params.viewport.screenSize).toBeUndefined();
    expect(out.params.viewport.isMobile).toBeUndefined();
    expect(out.params.browserContextId).toBe('ctx-1');
  });

  test('Browser.setDefaultViewport does not mutate the caller object', () => {
    const input = {
      method: 'Browser.setDefaultViewport',
      params: {
        browserContextId: 'ctx-1',
        viewport: {
          viewportSize: { width: 800, height: 600 },
          deviceScaleFactor: 1,
          isMobile: true,
        },
      },
    };
    const snapshot = JSON.parse(JSON.stringify(input));
    stripViewportFields(input);
    expect(input).toEqual(snapshot);
  });

  test('Browser.setDefaultViewport with viewport:null passes through untouched', () => {
    const input = {
      method: 'Browser.setDefaultViewport',
      params: { browserContextId: 'ctx-1', viewport: null },
    };
    const out = stripViewportFields(input);
    expect(out).toBe(input);
  });

  test('unrelated methods pass through untouched (by identity)', () => {
    const input = {
      id: 1,
      method: 'Page.navigate',
      params: { url: 'https://example.com', isMobile: true, screenSize: { width: 1, height: 1 } },
    };
    const out = stripViewportFields(input);
    // Not a viewport method — must not be modified even though it carries the fields.
    expect(out).toBe(input);
    expect(out.params.isMobile).toBe(true);
    expect(out.params.screenSize).toEqual({ width: 1, height: 1 });
  });

  test('viewport methods without the offending fields pass through by identity', () => {
    const page = { method: 'Page.setViewportSize', params: { viewportSize: { width: 10, height: 10 } } };
    expect(stripViewportFields(page)).toBe(page);
    const browser = { method: 'Browser.setDefaultViewport', params: { viewport: { viewportSize: { width: 10, height: 10 } } } };
    expect(stripViewportFields(browser)).toBe(browser);
  });

  test('null / non-object / missing params are handled safely', () => {
    expect(stripViewportFields(null)).toBeNull();
    expect(stripViewportFields(undefined)).toBeUndefined();
    expect(stripViewportFields(42)).toBe(42);
    const noParams = { method: 'Page.setViewportSize' };
    expect(stripViewportFields(noParams)).toBe(noParams);
  });

  test('does not corrupt other params on a viewport message', () => {
    const input = {
      method: 'Page.setViewportSize',
      sessionId: 'sess-9',
      params: {
        viewportSize: { width: 1280, height: 720 },
        screenSize: { width: 1280, height: 720 },
        isMobile: false,
        someFutureFlag: 'keep-me',
      },
    };
    const out = stripViewportFields(input);
    expect(out.params.someFutureFlag).toBe('keep-me');
    expect(out.params.viewportSize).toEqual({ width: 1280, height: 720 });
    expect(out.sessionId).toBe('sess-9');
  });
});

describe('installViewportTransportShim', () => {
  // A fake that mirrors the real 1.62.1 object graph:
  // browser._connection.toImpl(browser)._connection._transport.send
  function makeFakeBrowser() {
    const sent = [];
    const transport = { send: (m) => { sent.push(m); return 'ok'; } };
    const impl = { _connection: { _transport: transport } };
    const browser = { _connection: { toImpl: () => impl } };
    return { browser, transport, sent };
  }

  test('wraps transport.send so viewport fields are stripped before sending', () => {
    const { browser, transport, sent } = makeFakeBrowser();
    const ok = installViewportTransportShim(browser, () => {});
    expect(ok).toBe(true);
    expect(transport.__viewportShimInstalled).toBe(true);

    transport.send({
      method: 'Page.setViewportSize',
      params: { viewportSize: { width: 1, height: 2 }, screenSize: { width: 1, height: 2 }, isMobile: false },
    });
    expect(sent[0].params.screenSize).toBeUndefined();
    expect(sent[0].params.isMobile).toBeUndefined();
    expect(sent[0].params.viewportSize).toEqual({ width: 1, height: 2 });

    // Unrelated messages pass through untouched.
    transport.send({ method: 'Page.navigate', params: { url: 'x' } });
    expect(sent[1]).toEqual({ method: 'Page.navigate', params: { url: 'x' } });
  });

  test('is idempotent — does not double-wrap', () => {
    const { browser, transport } = makeFakeBrowser();
    installViewportTransportShim(browser, () => {});
    const firstSend = transport.send;
    const ok2 = installViewportTransportShim(browser, () => {});
    expect(ok2).toBe(true);
    expect(transport.send).toBe(firstSend);
  });

  test('returns false and leaves things alone when the connection shape is unexpected', () => {
    const log = jest.fn();
    expect(installViewportTransportShim({}, log)).toBe(false);
    expect(installViewportTransportShim({ _connection: {} }, log)).toBe(false);
    expect(log).toHaveBeenCalled();
  });

  test('returns false when the server-side transport is missing', () => {
    const browser = { _connection: { toImpl: () => ({ _connection: {} }) } };
    const log = jest.fn();
    expect(installViewportTransportShim(browser, log)).toBe(false);
    expect(log).toHaveBeenCalledWith('warn', expect.stringContaining('server-side transport'), expect.any(Object));
  });

  test('never throws — returns false if toImpl throws', () => {
    const browser = { _connection: { toImpl: () => { throw new Error('boom'); } } };
    const log = jest.fn();
    let result;
    expect(() => { result = installViewportTransportShim(browser, log); }).not.toThrow();
    expect(result).toBe(false);
    expect(log).toHaveBeenCalledWith('warn', expect.stringContaining('failed to install'), expect.any(Object));
  });
});
