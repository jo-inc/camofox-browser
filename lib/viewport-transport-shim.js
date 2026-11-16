'use strict';

// Camoufox's Juggler protocol (as shipped with Camoufox 152) does not recognize
// the `isMobile` / `screenSize` fields that Playwright 1.62's Firefox driver adds
// to the `Page.setViewportSize` and `Browser.setDefaultViewport` protocol
// messages. When those fields are present Camoufox rejects the call with a raw
// Protocol error, which breaks:
//   - POST /tabs/:tabId/viewport        (page.setViewportSize)
//   - browser.newContext({ viewport, deviceScaleFactor })
//
// `stripViewportFields` removes exactly those unsupported fields before the
// message is handed to the transport. It is pure: it never mutates the caller's
// message or params object — it returns a shallow copy with the offending keys
// removed, and passes every other message through unchanged (by identity).

/**
 * Strip the Juggler-incompatible `isMobile` / `screenSize` fields from a
 * protocol message, without mutating the input.
 *
 * @param {any} message - A Juggler protocol message, typically
 *   `{ id, method, params, sessionId }`.
 * @returns {any} The same message (by identity) when nothing needs stripping,
 *   otherwise a shallow copy with the unsupported fields removed.
 */
export function stripViewportFields(message) {
  if (!message || typeof message !== 'object') return message;

  const { method, params } = message;
  if (!params || typeof params !== 'object') return message;

  if (method === 'Page.setViewportSize') {
    if (!('screenSize' in params) && !('isMobile' in params)) return message;
    const nextParams = { ...params };
    delete nextParams.screenSize;
    delete nextParams.isMobile;
    return { ...message, params: nextParams };
  }

  if (method === 'Browser.setDefaultViewport') {
    const viewport = params.viewport;
    if (!viewport || typeof viewport !== 'object') return message;
    if (!('screenSize' in viewport) && !('isMobile' in viewport)) return message;
    const nextViewport = { ...viewport };
    delete nextViewport.screenSize;
    delete nextViewport.isMobile;
    return { ...message, params: { ...params, viewport: nextViewport } };
  }

  return message;
}

/**
 * Reach the Camoufox/Firefox Juggler transport from a launched Playwright
 * `browser` client object and wrap its `send` exactly once so that every
 * outgoing protocol message is passed through `stripViewportFields` first.
 *
 * On playwright-core 1.62.1 the client `browser._connection` is the *client*
 * dispatcher connection (it has no `_transport`). The in-process server-side
 * Firefox browser impl — which owns the real Juggler transport — is reachable
 * via `connection.toImpl(browser)._connection._transport`. This function is
 * fully defensive: if any part of that shape is missing (e.g. a future
 * Playwright reorganizes its internals), it logs a warning and leaves the
 * transport untouched instead of throwing during launch.
 *
 * @param {object} browser - The object returned by `firefox.launch(...)`.
 * @param {(level: string, msg: string, fields?: object) => void} [log] -
 *   Structured logger; defaults to a no-op.
 * @returns {boolean} true only when the wrap was installed successfully.
 */
export function installViewportTransportShim(browser, log = () => {}) {
  try {
    const connection = browser && browser._connection;
    if (!connection || typeof connection.toImpl !== 'function') {
      log('warn', 'viewport transport shim: client connection shape unexpected; skipping', {
        hasConnection: !!connection,
        hasToImpl: typeof connection?.toImpl,
      });
      return false;
    }

    const impl = connection.toImpl(browser);
    const transport = impl && impl._connection && impl._connection._transport;
    if (!transport || typeof transport.send !== 'function') {
      log('warn', 'viewport transport shim: server-side transport shape unexpected; skipping', {
        hasImpl: !!impl,
        hasImplConnection: !!impl?._connection,
        transportSend: typeof transport?.send,
      });
      return false;
    }

    if (transport.__viewportShimInstalled) {
      // Idempotent: never double-wrap the same transport.
      return true;
    }

    const originalSend = transport.send.bind(transport);
    transport.send = (message) => originalSend(stripViewportFields(message));
    transport.__viewportShimInstalled = true;

    log('info', 'viewport transport shim installed', {});
    return true;
  } catch (err) {
    // Must never throw during launch.
    log('warn', 'viewport transport shim: failed to install; leaving transport untouched', {
      error: err && err.message,
    });
    return false;
  }
}
