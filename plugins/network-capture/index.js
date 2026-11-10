/**
 * Network capture plugin.
 *
 * Attaches a short-lived page.on('response') / page.on('request') listener to an
 * existing tab and returns the matching traffic. Useful for reading API payloads
 * (GraphQL, XHR) that never reach the DOM.
 *
 * Disabled by default. Enable with ENABLE_NETWORK_CAPTURE=1 or
 * { "network-capture": { "enabled": true } } in camofox.config.json.
 *
 * Registers:
 *   POST /tabs/:tabId/capture-network  -- capture responses (with bodies)
 *   POST /tabs/:tabId/capture-requests -- capture outgoing requests (with post data)
 */

import express from 'express';
import { captureResponses, captureRequests } from './capture.js';
import { parseCaptureParams, CAPTURE_MAX_BODY_BYTES, REQUEST_MAX_BODY_BYTES_DEFAULT } from './params.js';
import { classifyError } from '../../lib/request-utils.js';

export function register(app, ctx) {
  const { log, events, sessions, findTab, normalizeUserId, safeError, failuresTotal } = ctx;

  // Shared wiring for both routes: validate input, resolve the tab, run the
  // capture. Everything ahead of the capture itself is rejected before the
  // listener is attached, so a bad request never touches the page.
  function captureRoute(route, { action, maxBodyBytesDefault, capture }) {
    app.post(route, ctx.auth(), express.json({ limit: '64kb' }), async (req, res) => {
      try {
        const { userId } = req.body;
        if (!userId) return res.status(400).json({ error: 'userId required' });

        const parsed = parseCaptureParams(req.body, { maxBodyBytesDefault });
        if (!parsed.ok) return res.status(400).json({ error: parsed.error, code: parsed.code });

        const session = sessions.get(normalizeUserId(userId));
        const found = session && findTab(session, req.params.tabId);
        if (!found) return res.status(404).json({ error: 'Tab not found' });
        session.lastAccess = Date.now();

        const { tabState } = found;
        tabState.toolCalls++; tabState.consecutiveTimeouts = 0; tabState.consecutiveFailures = 0;

        const result = await capture(tabState.page, parsed.params);

        events.emit(`tab:${action}`, { userId, tabId: req.params.tabId, captureCount: result.captureCount });
        res.json({ ok: true, ...result });
      } catch (err) {
        failuresTotal.labels(classifyError(err), action.replace('-', '_')).inc();
        log('error', `${action} failed`, { reqId: req.reqId, error: err.message });
        res.status(500).json({ error: safeError(err) });
      }
    });
  }

  captureRoute('/tabs/:tabId/capture-network', {
    action: 'capture-network',
    maxBodyBytesDefault: CAPTURE_MAX_BODY_BYTES.default,
    capture: captureResponses,
  });

  captureRoute('/tabs/:tabId/capture-requests', {
    action: 'capture-requests',
    maxBodyBytesDefault: REQUEST_MAX_BODY_BYTES_DEFAULT,
    capture: captureRequests,
  });
}
