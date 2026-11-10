# Network Capture Plugin — Agent Guide

Browser-level capture of a tab's network traffic. Attaches a short-lived `page.on('response')` or `page.on('request')` listener to an existing tab and returns the traffic whose URL matches a pattern. Useful for reading API payloads (GraphQL, XHR) that never reach the DOM.

## Endpoints

- `POST /tabs/:tabId/capture-network` — capture responses (URL, status, body) (requires auth)
- `POST /tabs/:tabId/capture-requests` — capture outgoing requests (URL, method, post data, headers) (requires auth)

## Activation

Disabled by default. Enable with `ENABLE_NETWORK_CAPTURE=1` env var or `"network-capture": { "enabled": true }` in `camofox.config.json`.

## Key Files

- `index.js` — route handlers only (no `child_process`, no `process.env` reads)
- `capture.js` — listener attach/detach and in-flight body draining
- `params.js` — input validation (URL pattern, limits)
- `capture.test.js`, `params.test.js`, `plugin.test.js` — unit and route tests

## Events

| Event | Payload |
|-------|---------|
| `tab:capture-network` | `{ userId, tabId, captureCount }` |
| `tab:capture-requests` | `{ userId, tabId, captureCount }` |

## Safety

- `urlPattern` is length-capped and rejects nested quantifiers (`(a+)+`) so a pathological regex can't run against every URL the browser sees
- `durationMs`, `maxCaptures` and `maxBodyBytes` are range-checked; out-of-range values are rejected with 400, never clamped
- Response bodies still in flight when the window closes are awaited for up to 5s; any still pending are returned as `__BODY_PENDING__` and counted in `pendingBodies`
