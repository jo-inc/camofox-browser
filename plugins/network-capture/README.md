# Network Capture Plugin

Capture a tab's network traffic for a fixed window and return the requests or responses whose URL matches a pattern. Typical use: read the JSON a single-page app fetches (GraphQL, REST) instead of scraping the rendered DOM.

## Enable

Disabled by default.

```bash
ENABLE_NETWORK_CAPTURE=1 npm start
```

Or in `camofox.config.json`:

```json
{
  "plugins": {
    "network-capture": { "enabled": true }
  }
}
```

## Usage

Start the capture, then trigger the traffic (navigate, click, scroll) from another request while the window is open. Both routes require auth (API key or loopback).

### `POST /tabs/:tabId/capture-network`

Captures responses.

```bash
curl -X POST http://localhost:9377/tabs/$TAB/capture-network \
  -H 'Content-Type: application/json' \
  -d '{"userId": "agent1", "urlPattern": "graphql", "durationMs": 10000}'
```

```json
{
  "ok": true,
  "captures": [{ "url": "https://example.com/graphql", "status": 200, "len": 1834, "body": "{\"data\":...}" }],
  "captureCount": 1,
  "droppedByLimit": 0,
  "pendingBodies": 0
}
```

### `POST /tabs/:tabId/capture-requests`

Captures outgoing requests.

```json
{
  "ok": true,
  "captures": [{ "url": "https://example.com/graphql", "method": "POST", "len": 92, "body": "{\"query\":...}", "headers": { "content-type": "application/json" } }],
  "captureCount": 1,
  "droppedByLimit": 0
}
```

### Parameters

| Field | Type | Default | Range | Notes |
|-------|------|---------|-------|-------|
| `userId` | string | — | — | Required |
| `urlPattern` | string | `graphql` | ≤ 200 chars | Case-insensitive regex; nested quantifiers such as `(a+)+` are rejected |
| `durationMs` | number | `15000` | 100–60000 | Capture window |
| `maxCaptures` | number | `100` | 1–500 | Further matches are counted in `droppedByLimit` |
| `maxBodyBytes` | number | `1000000` (responses), `200000` (requests) | 1024–5000000 | Longer bodies are cut and end with `__TRUNCATED__` |
| `includeHeaders` | boolean | `true` | — | `capture-requests` only |

Invalid input returns `400` with `{ error, code }`. An unknown tab returns `404`.

### Body markers

- `__TRUNCATED__` — body exceeded `maxBodyBytes`
- `__BODY_PENDING__` — response body still loading 5s after the window closed (counted in `pendingBodies`)
- `__BODY_ERROR__:<reason>` — the body could not be read (redirects, aborted requests)
