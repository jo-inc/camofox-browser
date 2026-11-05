# Camofox REST API: what to call

All requests except `GET /health` need `Authorization: Bearer <CAMOFOX_ACCESS_KEY>`.
Full machine-readable spec: `GET {BASE}/openapi.json`. Interactive docs: `GET {BASE}/docs`. Both need the key.

The viewer routes (`/live-viewer/*`) are provided by a plugin and are not in `openapi.json`. They are listed below.

## Tabs

| Call | Body or query | Returns |
|---|---|---|
| `POST /tabs` | body: `userId`, `sessionKey`, optional `url` | `tabId`, `url`, `title` |
| `GET /tabs` | query: `userId` | tabs for that user |
| `POST /tabs/{tabId}/navigate` | body: `userId`, `url` or `macro` + `query` | page info |
| `GET /tabs/{tabId}/state` | query: `userId` | `state.kind` (`ok`, `captcha`, `block`, `two_factor`, `login_wall`, `consent`, `no_results`), `title`, `text` |
| `GET /tabs/{tabId}/snapshot` | query: `userId` | accessibility snapshot with refs `e1`, `e2`, ... |
| `POST /tabs/{tabId}/click` | body: `userId`, `ref` or `selector` | result |
| `POST /tabs/{tabId}/type` | body: `userId`, `ref`, `text`, optional `pressEnter` | result |
| `POST /tabs/{tabId}/scroll` | body: `userId`, direction and amount (see `server.js`) | result |
| `POST /tabs/{tabId}/extract` | body: `userId`, `kinds` **or** `schema` | see below |
| `DELETE /tabs/{tabId}` | query or body: `userId` | `{ ok: true }` |
| `DELETE /sessions/{userId}` | none | closes that user's open session and tabs (does not delete saved logins) |

Action routes (click, type, scroll, navigate, extract, and others) return 409 `human_in_control` while a person holds the tab.

## Extract

One route, two modes. Send `kinds` (or nothing) or `schema`, never both.

- **kinds mode:** `{ "userId": "...", "kinds": ["tables", "prices", "json_ld", "listings"] }`. Leave `kinds` out for all four. Returns `tables` (with headers), `prices` (`amount`, `currency`), `json_ld` (`items`, `skipped`), `listings` (`title`, `url`, `price`). Needs no snapshot.
- **schema mode:** `{ "userId": "...", "schema": { "type": "object", "properties": { ... } } }`. Uses the refs from the last snapshot. Returns `data`. Returns 409 if no snapshot exists yet.

## Handoff and checkpoint

| Call | Body | Returns |
|---|---|---|
| `POST /tabs/{tabId}/checkpoint` | `userId`, optional `idleMs` | Reads the page. For captcha, login wall or two-factor, starts a handoff. `handoff` in the response |
| `POST /tabs/{tabId}/handoff` | `userId`, `reason`, optional `idleMs` | Starts a handoff directly |
| `POST /tabs/{tabId}/handoff/release` | `userId` | Returns the tab to the agent |
| `GET /tabs/{tabId}/control` | query: `userId` | `mode`: `agent` or `human` |

`idleMs` defaults to 10 minutes and is clamped to 10 seconds to 30 minutes.

## Viewer links (plugin)

| Call | Body or query | Returns |
|---|---|---|
| `POST /live-viewer/links` | Bearer key; body: `userId`, `tabId`, optional `control: true`, optional `ttlSeconds` | `url` (the viewer link), `expiresAt`. `control: true` needs an active handoff, else 409 `handoff_not_active` |
| `GET /live-viewer/view?t=...` | signed token | the viewer page (no key) |
| `GET /live-viewer/control?t=...` | signed token | `canControl`, `handoff` |

## Health

`GET /health` returns 200 with no key. Use it to confirm the base URL works before anything else.
