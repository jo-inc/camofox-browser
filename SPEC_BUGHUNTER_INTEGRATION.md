# camofox-browser — BugHunter integration spec (V20 / V22 / V23)

**Status:** Draft 1 — ready for `@coder` decomposition · **Author:** `@architect` (Opus, ultrathink) · **Date:** 2026-04-30 · **For implementation by:** `@coder` (Sonnet)

This spec adds eight new HTTP endpoints to camofox-browser to unblock three BugHunter test modes:

- **V20** (network-fault injection) — `POST /tabs/:tabId/network-fault`, `POST /tabs/:tabId/clear-network-fault`, `GET /tabs/:tabId/network-fault`. Drives offline / latency / failure / corruption scenarios so BugHunter can observe how the app degrades. Driven by `BugHunter/SPEC_V20_NETWORK_FAULTS.md`.
- **V22** (in-flight request enumeration) — `GET /tabs/:tabId/in-flight-requests`. Returns the set of `request` events the page has emitted but not yet matched with `requestfinished` / `requestfailed`. Drives `InterimState.inFlightRequests` in `BugHunter/SPEC_V22_NAV_STATE.md` § 3.3 / § 3.5; without this the V22 executor hard-codes `[]`.
- **V23** (time / clock injection) — `POST /tabs/:tabId/init-script`, `POST /tabs/:tabId/clear-init-scripts`, `POST /tabs/:tabId/timezone`, `POST /tabs/:tabId/clear-timezone`. Lets BugHunter install a `Date` polyfill before app code runs, and override the timezone the page sees. Driven by `BugHunter/SPEC_V23_TIME_CLOCK.md`.

The matching MCP wrappers live in `cunninghambe/camofox-mcp` and are specced separately in that repo's `SPEC_BUGHUNTER_INTEGRATION.md`. Tool-name and shape parity between the two specs is a hard requirement.

---

## 1. Problem Statement

BugHunter walks an SPA, drives mutating actions, and classifies what breaks. Three classes of bugs require *environmental* injection — making the network slow, refreshing mid-mutation while observing what was in-flight, jumping the clock to next year — and there is currently no camofox primitive for any of them. BugHunter's V22 implementation already ships with `inFlightRequests` hard-wired to `[]` because no MCP tool exposes the data; V20 and V23 cannot ship at all without new endpoints.

This spec adds the eight endpoints those three modes need. All three modes are pure observation — no new automation, no new auth, no schema migrations on the camofox side. Each endpoint maps to one or two Playwright primitives that are already reachable via the existing `tabState.page` / `session.context` handles.

## 2. Boundaries

### In scope (this PR)

- **Network conditioning**:
  - `POST /tabs/:tabId/network-fault` with `{ mode, latencyMs?, percent?, statusCode? }`. Modes: `offline`, `slow_3g`, `high_latency`, `timeout_at_request`, `timeout_at_response`, `intermittent`, `server_5xx`, `malformed_response`.
  - `POST /tabs/:tabId/clear-network-fault` removes the active fault and restores normal network behaviour.
  - `GET /tabs/:tabId/network-fault` returns the currently-active fault (for diagnostics and idempotent re-checks).
- **In-flight request enumeration**:
  - `GET /tabs/:tabId/in-flight-requests` returns `{ requests: Array<{ method, url, path, startedAtMs, resourceType }>, capturedAtMs }`.
  - Backed by a per-page `Map<Request, RequestRecord>` populated on `page.on('request')` and drained on `page.on('requestfinished')` / `page.on('requestfailed')`.
- **Init-script injection**:
  - `POST /tabs/:tabId/init-script` with `{ script, id? }` — wraps `page.addInitScript(script)`. Returns `{ id, ok }`.
  - `POST /tabs/:tabId/clear-init-scripts` — drops the per-tab registry of installed scripts. Documented caveat: Playwright has no first-class "remove init script" API; clearing requires the page to be **reloaded into a fresh document for the scripts to actually stop running on subsequent navigations**. See § 7 edge case 6.
- **Timezone override**:
  - `POST /tabs/:tabId/timezone` with `{ id }` (IANA timezone, e.g. `"America/New_York"`).
  - `POST /tabs/:tabId/clear-timezone` — restores the context's creation-time timezone.

### Out of scope (this PR)

- New MCP tools — that's the sibling spec in `camofox-mcp`.
- Geolocation, locale, color-scheme, or any non-time non-network emulation. Open one spec at a time.
- Per-request fault patterns beyond the eight modes listed (e.g. "fail every 3rd POST to `/api/x` only when the user-agent matches Y"). The eight modes cover the full V20 surface; finer-grained injection waits for evidence.
- Programmatic introspection of the route handler (e.g. "how many requests have been faulted so far"). Stats are picked up from the existing Prometheus metrics surface if needed; not a new endpoint.
- Persisting fault state across `tabState.page` recreations. A faulted tab whose page is replaced (auto-recover, crash-restart) starts clean. Documented in § 7 edge case 5.
- BFCache or service-worker cache override. Not in scope; see V22 § 2 out-of-scope for the equivalent statement.
- Removing the `page.addInitScript` Disposable returned in Playwright 1.50+. We hold the disposable on the per-tab registry, but there is no public `dispose()` semantics in Playwright that uninstalls a script from already-loaded documents — only future ones. Calling `.dispose()` is a best-effort hook; see § 4.4.
- Auth changes. All endpoints reuse the existing `userId` lookup envelope; no new tokens, no new secrets. Endpoints accessing the cookie jar are out of scope here entirely.

### External dependencies

- Playwright `BrowserContext.setOffline()` (verified in `node_modules/playwright-core/types/types.d.ts:9395`).
- Playwright `BrowserContext.route(url, handler)` and `unrouteAll(options?)` (verified at `:9535`).
- Playwright `Page.on('request' | 'requestfinished' | 'requestfailed', ...)` (verified at `:1190`, `:1209`, `:1215`).
- Playwright `Page.addInitScript(script)` returning `Disposable` (verified at `:318`; class `Page` at `:8294`).
- **Not** available in this Playwright version on Firefox: `BrowserContext.setTimezoneId(id)` as a runtime mutator. `timezoneId` is a creation-time-only context option (verified by absence of a `setTimezoneId` member on `BrowserContext` in the type defs — only the `timezoneId?: string` property on `BrowserNewContextOptions`). `CDPSession.send('Emulation.setTimezoneOverride')` is Chromium-only and unavailable in Firefox. **§ 4.6 documents the chosen alternative: `page.addInitScript`-based timezone polyfill.**
- No new npm dependencies.

## 3. Existing Code to Reuse

### Files you MUST read before writing any code

- `server.js` lines 2016–2129 (`POST /tabs`) — session creation flow including `session.context.newPage()`, where per-page event listeners must be wired.
- `server.js` lines 2131–2340 (`POST /tabs/:tabId/navigate`) — auth-envelope and `findTab` pattern for tab-scoped routes; copy verbatim.
- `server.js` lines 3109–3133 (`POST /tabs/:tabId/viewport`) — closest analogue for a simple write-side tab endpoint that delegates to a single Playwright call.
- `server.js` lines 3177–3210 (`POST /tabs/:tabId/back`) — shows the `withTabLock(tabId, async () => {...})` pattern for routes that can race with concurrent navigation. Network-fault writes MUST hold the tab lock; in-flight reads do NOT need it.
- `server.js` lines 3756–3892 (`POST /tabs/:tabId/evaluate`) — the largest tab-scoped POST; shows `express.json({ limit })` and `safeError(err)` usage for routes that take untrusted text input. Copy the limit guard for `/init-script`.
- `server.js` lines 3968–4028 (`DELETE /tabs/:tabId`) — teardown path; the in-flight tracker MUST register a teardown hook here so the per-page Maps are released.
- `server.js` lines 1043–1100 (session creation) — shows how `contextOptions.timezoneId = 'America/Los_Angeles'` is the only place a timezone is set today. The new `/timezone` endpoint must NOT mutate context creation; it operates per-page via init-script.
- `server.js` line 293 (`POST /sessions/:userId/cookies`) — security envelope reference (loopback / API key). Network-fault endpoints reuse the existing per-tab envelope (no `CAMOFOX_API_KEY` requirement); they do not touch credentials.
- `lib/` directory — utility helpers including `safeError`, `classifyError`, `withTabLock`, `findTab`, `normalizeUserId`. Reuse all of these. **Do not reimplement any of them.**

### Patterns to follow

- **Tab lookup**: `const session = sessions.get(normalizeUserId(userId)); const found = session && findTab(session, req.params.tabId); if (!found) return res.status(404).json({ error: 'Tab not found' });`. Verbatim across every route added in this PR.
- **Per-tab state**: store new state on `tabState.networkFault`, `tabState.inFlight`, `tabState.initScripts`, `tabState.timezoneInitScriptId`. The `tabState` object is created in `POST /tabs`; extending it is additive.
- **Error envelope**: catch at the top level, `log('error', '<route> failed', { reqId, error: err.message })`, then `handleRouteError(err, req, res)`. Same as every existing route.
- **Metrics**: increment `failuresTotal.labels(classifyError(err), '<route_name>').inc()` on the failure path, matching `/snapshot` and the cookies route precedent.
- **Plugin events**: emit `pluginEvents.emit('tab:<event>', payload)` for state-changing routes (mirror the `tab:viewport` emit at `server.js:3127`). New events: `tab:network_fault_set`, `tab:network_fault_cleared`, `tab:init_script_added`, `tab:init_scripts_cleared`, `tab:timezone_set`, `tab:timezone_cleared`. Read-only routes (`GET /network-fault`, `GET /in-flight-requests`) emit nothing.

### DO NOT

- Do NOT add new files under `lib/` or `plugins/`. Everything lands in `server.js`. The other tab routes live in `server.js`; uniformity matters.
- Do NOT touch `session.context.newContext` creation. Timezone override is per-page via init-script; it does NOT replace context creation.
- Do NOT introduce a new top-level `/network-fault` route (without `/tabs/:tabId`). All faults are tab-scoped — they wire on the page's context but the lifecycle is owned by the tab.
- Do NOT use `page.route()` for V20 fault injection. The fault must apply to ALL tabs in the same context if BugHunter has multiple tabs open against the same SPA. Use `session.context.route()`. § 4.1 details the per-context-with-tab-tagging design.
- Do NOT block the route on the in-flight set. `GET /in-flight-requests` must return synchronously from the in-memory tracker; do not query Playwright at request time.
- Do NOT clear in-flight tracker entries on `requestfinished`'s response status. Track until the *request* lifecycle ends, regardless of HTTP status. The V22 classifier discriminates 200 vs 5xx separately.
- Do NOT echo the user's `script` body in success responses. The init-script payload may contain secrets (test fixtures); echo only the `id`.
- Do NOT auto-clear faults on navigation. BugHunter explicitly clears them when done; auto-clearing would break refresh-mid-mutation (V22 + V20 chained).
- Do NOT add a `force: true` parameter that bypasses tab locks. Faults during a navigation are explicitly part of the V22 / V20 surface; the lock acquisition has a 10 s ceiling already.
- Do NOT add a websocket / SSE channel for in-flight events. BugHunter polls; the latency is acceptable.

## 4. Interface Contract — new endpoints

All eight endpoints follow the existing tab-scoped envelope:

- Auth: same as the existing tab routes (loopback or `CAMOFOX_API_KEY` bearer; per-tab `userId` lookup).
- Body content type: `application/json` (write endpoints).
- Response content type: `application/json`.
- Common error shape: `{ error: string }` with HTTP 400 / 404 / 500.

### 4.1 `POST /tabs/:tabId/network-fault` — install fault

**Driven by:** BugHunter `SPEC_V20_NETWORK_FAULTS.md` § "Browser primitive" (all eight modes route through this single endpoint).

**Request body:**

```ts
type NetworkFaultRequest = {
  userId: string;
  mode:
    | 'offline'
    | 'slow_3g'
    | 'high_latency'
    | 'timeout_at_request'
    | 'timeout_at_response'
    | 'intermittent'
    | 'server_5xx'
    | 'malformed_response';
  /** Required for 'high_latency'. Accepted for 'slow_3g' as override (default 2000). Rejected for others. */
  latencyMs?: number;
  /** Required for 'intermittent'. Range 1..99 inclusive. Rejected for others. */
  percent?: number;
  /** Required for 'server_5xx'. Range 500..599. Defaults to 503. Rejected for others. */
  statusCode?: number;
  /**
   * Optional URL-glob to scope the fault. Defaults to '**\/api/**' for fault modes that target XHR/fetch
   * (everything except 'offline', which is whole-context). Pass '**\/*' for blanket faulting.
   */
  urlGlob?: string;
};
```

**Response (success, 200):**

```ts
type NetworkFaultResponse = {
  ok: true;
  tabId: string;
  fault: {
    mode: NetworkFaultRequest['mode'];
    latencyMs?: number;
    percent?: number;
    statusCode?: number;
    urlGlob?: string;
    installedAtMs: number; // Date.now() when fault took effect
  };
};
```

**Mode → Playwright primitive mapping:**

| `mode` | Driver | Per-request handler |
|---|---|---|
| `offline` | `session.context.setOffline(true)` | n/a (whole-context kill switch) |
| `slow_3g` | `session.context.route(urlGlob, handler)` | `await sleep(latencyMs ?? 2000); await route.continue();` |
| `high_latency` | `session.context.route(urlGlob, handler)` | `await sleep(latencyMs); await route.continue();` (latencyMs required, ≥ 1, ≤ 120000) |
| `timeout_at_request` | `session.context.route(urlGlob, handler)` | `await sleep(120000); await route.abort('timedout');` (effectively never resolves within the test budget) |
| `timeout_at_response` | `session.context.route(urlGlob, handler)` | `await route.continue(); /* response stalls upstream — emulate by NOT calling continue/fulfill, simulating a hung response */`. **Implementation:** `setTimeout(() => route.abort('timedout'), 120000)` — let request go, then time it out. |
| `intermittent` | `session.context.route(urlGlob, handler)` | `if (Math.random() * 100 < percent) await route.abort('failed'); else await route.continue();` |
| `server_5xx` | `session.context.route(urlGlob, handler)` | `await route.fulfill({ status: statusCode, contentType: 'application/json', body: JSON.stringify({ error: 'Injected fault' }) });` |
| `malformed_response` | `session.context.route(urlGlob, handler)` | `await route.fulfill({ status: 200, contentType: 'application/json', body: '{"truncated":' });` (intentional invalid JSON) |

**Single-fault invariant.** Only one fault active per tab. Calling `POST /network-fault` while a fault is already installed returns `409 Conflict` with `{ error: 'Fault already active. Call POST /tabs/:tabId/clear-network-fault first.', existing: <current fault> }`. The coder may instead choose to replace-and-warn, but the spec defaults to **explicit-clear-required** — two installs back-to-back is a planner bug, not a feature.

**Per-context vs per-tab scope.** The Playwright `route()` and `setOffline()` methods are per-context (i.e. shared across all tabs in the same context). This is correct for V20: BugHunter typically opens one tab per test against one SPA, so per-context = per-tab in practice. **Documented:** if BugHunter ever opens two tabs in the same context, faulting tab A also faults tab B until cleared. Tracked under `tabState.networkFault` for each tab independently for diagnostic purposes; the actual Playwright handler is registered once on `session.context` and torn down when the LAST faulted tab clears. Reference-counted.

**Validation:**
- `mode` is required and must be one of the eight listed values → 400 `{error: 'Invalid mode: <value>'}` otherwise.
- `latencyMs` required iff mode ∈ `{ high_latency, slow_3g, timeout_at_request, timeout_at_response }` (the last two ignore the value but accept it without error). Range 1..120000.
- `percent` required iff mode = `intermittent`. Range 1..99.
- `statusCode` accepted iff mode = `server_5xx`. Range 500..599. Defaults to 503.
- `urlGlob` accepted for all modes except `offline` (silently ignored for `offline`).
- Reject any of the above when set on a mode that doesn't accept them: 400 `{error: '<param> not valid for mode <mode>'}`.

### 4.2 `POST /tabs/:tabId/clear-network-fault` — remove fault

**Request body:** `{ userId: string }`

**Response (200):** `{ ok: true, tabId, cleared: <previous fault state | null> }`. Returns `cleared: null` when no fault was active (idempotent — does NOT 404).

**Behaviour:**
- If `tabState.networkFault.mode === 'offline'`: `await session.context.setOffline(false)`.
- Else: decrement the per-context reference count for the active route handler. When count reaches zero, call `session.context.unrouteAll({ behavior: 'wait' })` to drain in-flight handler invocations cleanly. Document `behavior: 'wait'` as the chosen mode (other options: `'ignoreErrors'`, `'default'` — `wait` is the safest for tests).
- Clear `tabState.networkFault`.
- Emit `pluginEvents.emit('tab:network_fault_cleared', { userId, tabId })`.

### 4.3 `GET /tabs/:tabId/network-fault` — read fault state

**Query params:** `?userId=<id>`

**Response (200):**

```ts
{
  tabId: string;
  fault: NetworkFaultResponse['fault'] | null; // null if no fault active
}
```

Read-only; does not require `withTabLock`. Used for diagnostics and as an idempotent-check during BugHunter's planner phase before a chained test.

### 4.4 `GET /tabs/:tabId/in-flight-requests` — read in-flight tracker

**Driven by:** BugHunter `SPEC_V22_NAV_STATE.md` § 3.3 (`InterimState.inFlightRequests`) and § 3.5 (capture between seed-fire and refresh-mid-mutation). The current V22 hard-codes `[]` because no mechanism exists.

**Query params:** `?userId=<id>&methods=<csv>`

- `methods` optional, default `'GET,POST,PUT,PATCH,DELETE,HEAD,OPTIONS'`. Comma-separated. Restrict to mutating-only with `methods=POST,PUT,PATCH,DELETE`.

**Response (200):**

```ts
type InFlightResponse = {
  tabId: string;
  capturedAtMs: number;
  requests: Array<{
    method: string;             // uppercase
    url: string;                // full URL
    path: string;               // pathname only (host stripped); matches V22 cluster signature shape
    startedAtMs: number;        // Date.now() when 'request' event fired
    resourceType: string;       // 'fetch' | 'xhr' | 'document' | 'image' | etc. (from Playwright's request.resourceType())
  }>;
};
```

**Implementation:**

When a tab is created in `POST /tabs` (or restored after auto-recovery), wire three listeners on `tabState.page`:

```js
const inFlight = new Map(); // Map<Request, { method, url, path, startedAtMs, resourceType }>
tabState.page.on('request', (request) => {
  inFlight.set(request, {
    method: request.method().toUpperCase(),
    url: request.url(),
    path: safeUrlPath(request.url()),
    startedAtMs: Date.now(),
    resourceType: request.resourceType(),
  });
});
const drop = (request) => inFlight.delete(request);
tabState.page.on('requestfinished', drop);
tabState.page.on('requestfailed', drop);
tabState.inFlight = inFlight;
```

`safeUrlPath(url)` is a small helper: `try { return new URL(url).pathname; } catch { return url; }`. New helper, lives at the top of `server.js` next to `safeError`.

The `GET` route reads `[...tabState.inFlight.values()]` synchronously, optionally filtering by `methods`, and returns. **No async work in the route handler.** Latency is dominated by the JSON serialization.

**Lifecycle:**

- The tracker is **per-page**. When `tabState.page` is replaced (auto-recovery, navigation does NOT replace the page), a new Map is installed.
- Navigations within the same page DO NOT clear the tracker — that is by design. V22's `back-after-mutation` test reads the tracker AFTER the seed has dispatched and BEFORE the back. Stale entries from before the seed are filtered out by V22's classifier on `startedAtMs`.
- If a request neither finishes nor fails (network never responds), the entry stays forever in the tracker, leaking memory. **Mitigation:** add a 5-minute TTL sweep that runs once per tab heartbeat (the existing heartbeat tick is at `server.js:~1043`; add a one-line drain). Entries older than 5 minutes are dropped on the next sweep. § 7 edge case 7.

**Error cases:**
- 404 `Tab not found` — same as other routes.
- No 500 paths in normal operation — the tracker is an in-memory Map.

### 4.5 `POST /tabs/:tabId/init-script` — install init-script

**Driven by:** BugHunter `SPEC_V23_TIME_CLOCK.md` § "Inject before app code via Playwright addInitScript".

**Request body:**

```ts
type InitScriptRequest = {
  userId: string;
  /** JS source to evaluate before any other script in the new document.
   *  Max 256 KB. Wrapped in try/catch internally — exceptions are silenced
   *  to avoid breaking the page; consumers should self-instrument logging. */
  script: string;
  /** Optional caller-supplied id for this script. If omitted, server generates a UUID.
   *  Stored on tabState.initScripts to support clear-by-id (future). */
  id?: string;
};
```

**Response (200):**

```ts
{
  ok: true;
  tabId: string;
  id: string;            // returned id (server-generated if not supplied)
  installedAtMs: number;
  scriptLength: number;  // characters; for diagnostics, NOT the script body
}
```

**Implementation:**

```js
app.post('/tabs/:tabId/init-script', express.json({ limit: '256kb' }), async (req, res) => {
  // 1. Auth + findTab.
  // 2. Validate: typeof script === 'string' && script.length > 0 && script.length <= 262144.
  // 3. const id = req.body.id || crypto.randomUUID();
  // 4. Reject if id already exists in tabState.initScripts → 409.
  // 5. const disposable = await tabState.page.addInitScript(script);
  // 6. tabState.initScripts.set(id, { disposable, script, installedAtMs: Date.now(), scriptLength: script.length });
  // 7. Emit 'tab:init_script_added'.
  // 8. Respond.
});
```

**Critical Playwright semantics** (documented for the coder):

- `addInitScript` registers the script to run on **every new document the page navigates to**, including iframes that share the page's origin policy. It does NOT run on the *current* document (i.e. the script is for the next navigation onward).
- For BugHunter V23, this is the correct shape: the planner installs the time polyfill, then drives the navigation that loads the SPA. The polyfill runs before the SPA's bundle.
- The returned `Disposable` (in Playwright 1.50+) can be `.dispose()`d, but disposing a script does NOT undo its effects on already-loaded documents. It only prevents the script from running on future navigations of the same page. § 4.6 below for the consequence.

**Body size:** 256 KB ceiling matches `/evaluate`. A 256 KB JS script is more than enough for a Date polyfill (the entire `lolex` library minified is ~30 KB). Reject larger payloads with 413.

### 4.6 `POST /tabs/:tabId/clear-init-scripts` — best-effort clear

**Request body:** `{ userId: string }`

**Response (200):**

```ts
{
  ok: true;
  tabId: string;
  cleared: number;          // count of scripts disposed
  reloadRequired: boolean;  // true if any scripts were active; current document still has them applied
}
```

**Behaviour:**

- For each entry in `tabState.initScripts`, call `entry.disposable.dispose()`. Catch and ignore errors — disposal is best-effort.
- Empty `tabState.initScripts`.
- Set `reloadRequired = true` if at least one script existed. Document that the caller (BugHunter) must trigger a reload or new navigation to fully clear the polyfill from the page state.
- Emit `'tab:init_scripts_cleared'`.

**Hard caveat (documented in JSDoc on the route):**

> `clear-init-scripts` does NOT remove the polyfill from the currently-loaded document. Playwright cannot un-evaluate a script that has already run. To fully clear: call this endpoint, then reload the tab. For BugHunter V23, this is acceptable — the polyfill is installed before navigation, and tests are isolated by tab anyway.

### 4.7 `POST /tabs/:tabId/timezone` — set timezone via init-script

**Driven by:** BugHunter `SPEC_V23_TIME_CLOCK.md` § "Timezone override".

**Request body:**

```ts
{
  userId: string;
  id: string;  // IANA timezone identifier, e.g. 'America/New_York', 'Europe/London', 'UTC'
}
```

**Response (200):**

```ts
{
  ok: true;
  tabId: string;
  timezoneId: string;
  appliedVia: 'init-script';   // documents the implementation strategy for telemetry / diagnostics
  reloadRequired: true;        // ALWAYS true — see § 4.6 caveat
}
```

**Implementation strategy (the consequential decision):**

Playwright 1.50+ on Firefox does NOT expose `BrowserContext.setTimezoneId()` as a runtime mutator. The CDP `Emulation.setTimezoneOverride` path is Chromium-only and unavailable. The two viable alternatives:

1. **Recreate the context with `timezoneId` in `newContext()`** — destroys cookies, in-flight state, every other tab. Unacceptable.
2. **Inject a timezone polyfill via `page.addInitScript()`** — runs before page JS, replaces `Intl.DateTimeFormat.prototype.resolvedOptions().timeZone`, intercepts `Date.prototype.getTimezoneOffset()`, hooks `Date.prototype.toLocaleString()`. Persists across navigations within the same page (init-scripts re-run on every new document). Standard polyfill from the `timezone-mock` family is ~3 KB. **Chosen approach.**

The route is a thin wrapper over the polyfill template:

```js
app.post('/tabs/:tabId/timezone', express.json(), async (req, res) => {
  // 1. Auth + findTab.
  // 2. Validate: typeof id === 'string' and matches IANA timezone regex (Continent/City format,
  //    plus 'UTC'). Use a minimal allow-list regex; do not pull in moment-timezone.
  // 3. If tabState.timezoneInitScriptId is already set, dispose its entry first (single-timezone invariant).
  // 4. const polyfill = renderTimezonePolyfill(id); // template literal in lib/timezone-polyfill.js
  // 5. const disposable = await tabState.page.addInitScript(polyfill);
  // 6. const scriptId = crypto.randomUUID();
  //    tabState.initScripts.set(scriptId, { disposable, ... });
  //    tabState.timezoneInitScriptId = scriptId;
  // 7. Emit 'tab:timezone_set'.
  // 8. Respond with reloadRequired: true.
});
```

The polyfill template lives in `lib/timezone-polyfill.js` — small, no external deps. The coder writes it. Polyfill scope:

- `Date.prototype.getTimezoneOffset` → returns the offset for the requested zone at `this.valueOf()` (DST-aware).
- `Date.prototype.toString`, `toLocaleString`, `toLocaleDateString`, `toLocaleTimeString` → render in the new zone.
- `Intl.DateTimeFormat` → constructor wrapper that defaults `timeZone` to the new zone unless caller specifies one.

Timezone offset table is Node's `Intl` evaluated at install-time on the server, then embedded as a JS literal in the template. Avoids pulling `moment-timezone` (200 KB) into the page.

### 4.8 `POST /tabs/:tabId/clear-timezone` — restore default

**Request body:** `{ userId: string }`

**Response (200):**

```ts
{
  ok: true;
  tabId: string;
  cleared: boolean;          // true if a timezone override was active
  reloadRequired: boolean;   // true if cleared
}
```

**Behaviour:**

- If `tabState.timezoneInitScriptId` set: dispose the matching entry in `tabState.initScripts`, drop both. Set `cleared: true, reloadRequired: true`.
- Else: `cleared: false, reloadRequired: false`.
- Emit `'tab:timezone_cleared'`.

Hard caveat — same as § 4.6: caller must reload to fully clear from the loaded document.

## 5. Per-tab state additions

In `POST /tabs` (server.js:~2080), extend `tabState` with:

```js
{
  // ... existing fields ...
  networkFault: null,          // { mode, latencyMs?, percent?, statusCode?, urlGlob?, installedAtMs, _routeHandler? } | null
  inFlight: new Map(),         // Map<Request, { method, url, path, startedAtMs, resourceType }>
  initScripts: new Map(),      // Map<id, { disposable, scriptLength, installedAtMs }>
  timezoneInitScriptId: null,  // string id pointing into initScripts | null
}
```

`_routeHandler` is the Playwright handler closure registered with `context.route()`. Stored so `clear-network-fault` can pass it back to `context.unroute(urlGlob, handler)` if we later switch from `unrouteAll` to targeted unroute. Out of v0.1 scope but worth reserving the field.

## 6. Acceptance Criteria

1. `npx jest` (existing test runner) green. Tests required:
   - `tests/network-fault.test.js`: install + clear for each of the eight modes; idempotency of clear-on-no-fault; 409 on double-install; 400 on missing required params per mode.
   - `tests/in-flight-requests.test.js`: tracker populates on `request`, drains on `requestfinished` and `requestfailed`; methods filter; survives navigations within page; TTL sweep removes stale entries.
   - `tests/init-script.test.js`: installs script, returns id; clear-init-scripts disposes; reject >256 KB body.
   - `tests/timezone.test.js`: install timezone polyfill; verify via `evaluate('new Date().toLocaleString("en-US")')` the page sees the new zone after a navigation; clear restores baseline.
2. `npx eslint .` clean.
3. New routes follow the existing `app.<method>('/tabs/:tabId/...')` pattern verbatim: `findTab` lookup, `withTabLock` for state-mutating, `handleRouteError`, plugin-events emit.
4. `openapi.json` updated to include all eight new routes with their request / response schemas. Generated or hand-edited; the existing routes have OpenAPI JSDoc comments — match that pattern.
5. README updated with a one-line entry per new route under the "Routes" section.
6. **Manual smoke** against TraiderJo (or any local SPA):
   - `curl -X POST -d '{"userId":"claude","mode":"high_latency","latencyMs":2000}' http://127.0.0.1:9377/tabs/<tabId>/network-fault` then exercise the page; see ≥ 2 s on every fetch.
   - `curl -X POST -d '{"userId":"claude","mode":"server_5xx","statusCode":503}' ...` then trigger a mutation; see the SPA's error UI.
   - `curl 'http://127.0.0.1:9377/tabs/<tabId>/in-flight-requests?userId=claude'` mid-mutation; see at least one entry with the expected method.
   - `curl -X POST -d '{"userId":"claude","script":"window.__ZONE = \"injected\";"}' .../init-script` then `evaluate('window.__ZONE')` after a reload → `"injected"`.
   - `curl -X POST -d '{"userId":"claude","id":"Asia/Tokyo"}' .../timezone` then reload, then `evaluate('new Date().toString()')` → string containing `JST` or `+0900`.
7. **Plugin events** fire exactly once per state change (asserted via a test plugin that subscribes and counts).
8. **No new emoji** anywhere in code or comments.
9. **Functions max 40 lines.** The route handlers each delegate to one helper (`installFault`, `installInitScript`, `installTimezone`, etc.) at module top.

## 7. Edge cases

1. **Double-install of fault.** Returns 409 with the existing fault echoed. Caller must `clear-network-fault` first. Prevents reference-count bugs.

2. **Clear-fault when no fault active.** Idempotent. Returns 200 with `cleared: null`. Allows BugHunter to clear without first checking GET.

3. **Fault during navigation.** The fault is registered on `session.context.route()`, so it applies to in-flight requests after registration regardless of which page started them. A `high_latency` fault installed mid-navigation may delay the navigation's own document fetch — that is desired behaviour for V20's `timeout_at_request` test.

4. **Fault on cross-origin frames.** `context.route()` matches against the request URL; cross-origin frames belong to the same context and ARE faulted. Documented. If BugHunter wants per-origin scoping, use `urlGlob` with the target origin's prefix.

5. **Tab page replaced (auto-recover).** The new `tabState.page` does NOT have the in-flight listeners attached. The fault state on `session.context` survives (context is shared), but the in-flight tracker resets to empty. BugHunter sees an empty `inFlightRequests` list immediately after recovery, which is the correct semantics — we genuinely don't know what was in-flight before the crash. Document that re-installing init-scripts after auto-recover is the caller's responsibility.

6. **Init-script clear caveat.** Disposing an init-script's `Disposable` does NOT remove its effects from the currently-loaded document. The script ran; its state mutations (window.* assignments, prototype patches) persist. To fully clear: call `clear-init-scripts`, then trigger a navigation. The response includes `reloadRequired: true` to make the caller's life easier.

7. **In-flight tracker leak.** A request that never completes (network black-hole, server kill -9) stays in the Map forever. TTL sweep at 5 minutes is the mitigation. The 5-minute window is long enough that V22's interim-state capture window (≤ 30 s) is unaffected, but short enough to bound memory.

8. **`offline` mode and other modes interact.** Only one fault active at a time per tab (single-fault invariant § 4.1). `offline` is exclusive — you cannot layer `high_latency` on top of `offline`. If BugHunter wants both behaviours, it sequences them: fault A → exercise → clear → fault B → exercise → clear.

9. **`server_5xx` returns valid JSON; some apps don't accept JSON content-type.** The fault handler defaults to `Content-Type: application/json`. If a SPA explicitly checks `Content-Type` and the fault is targeting an HTML endpoint, the SPA's error path may differ. **Accepted as a known limitation.** A future spec may add `responseContentType` to the fault payload; not in v0.1.

10. **`malformed_response` produces invalid JSON only.** It does not produce other malformations (truncated XML, bad gzip, etc.). The single mutation — `'{"truncated":'` — is enough to trigger `JSON.parse` failures in the tested code paths. Documented.

11. **Init-script body contains the user's secrets.** The script payload is logged at `info` level via `log()` calls only with its `length`, NEVER its content. Confirmed by reading `server.js`'s log calls and matching the convention. The success response also returns only `scriptLength`, not the script.

12. **Timezone polyfill collides with another init-script that patches `Date`.** Last writer wins per init-script registration order. The single-timezone invariant (§ 4.7 step 3) prevents two timezone polyfills from coexisting. If a caller installs a Date-mutating init-script *after* `/timezone`, the caller's script wins on the next navigation. **Documented; no automated guard.**

13. **DST transitions during a test.** The polyfill computes offset from `Intl` at *evaluation time inside the page*, not at install-time on the server (subtle). Each `Date` constructor call computes its offset based on the timestamp's wall-clock vs the named zone. DST transitions are honoured. Validated by an explicit test fixture: install `America/New_York`, construct `new Date('2024-03-10T07:00:00Z')` (1 minute before US-Eastern DST starts), verify offset = -300 (EST); construct `new Date('2024-03-10T07:00:01Z')` and verify offset = -240 (EDT).

14. **Timezone polyfill and BugHunter V23 chrono-jump.** V23 also installs a `Date.now()` jump. The two init-scripts must not collide. Order: timezone-polyfill installs first, chrono-jump (separate spec) installs second. The chrono-jump wraps the constructor — when it calls through to the underlying `Date`, the timezone polyfill's `Date.prototype.toString` is what serializes. This is the correct nesting order. Documented; caller (BugHunter) responsible for install order.

15. **`urlGlob` with an invalid glob.** Playwright's `route()` accepts strings, regexes, or functions. We restrict to strings. Validate as a Playwright glob pattern: must contain `**` or `*` or be a literal path; reject `null`, empty string with 400. Edge cases like `'**'` (all URLs) are valid; `'(.*)'` is treated as a literal string by Playwright's glob matcher and would never match — accepted but warned in the response. Future hardening: detect regex-shaped strings; out of v0.1.

## 8. Files to touch

**Modify:**
- `server.js` — add eight route handlers; extend `tabState` initialization; add helpers (`safeUrlPath`, `installFault`, `installInitScript`, `installTimezone`, `inFlightSweep`); wire page-event listeners on tab creation and replacement; wire teardown on `DELETE /tabs/:tabId`.
- `openapi.json` — add eight new route schemas.
- `README.md` — add Routes section entries.
- `package.json` — no new deps (verified — Playwright already at 1.50+).
- `tests/` — four new test files (§ 6).

**Create:**
- `lib/timezone-polyfill.js` — polyfill template renderer. ~120 LOC max.
- `tests/network-fault.test.js`
- `tests/in-flight-requests.test.js`
- `tests/init-script.test.js`
- `tests/timezone.test.js`

**No new directories.** All new files in existing dirs.

## 9. Definition of Done

A reviewer can:

```bash
cd /tmp/camofox-browser-fork
npm ci && npx jest               # green
node server.js &                 # boot the server
# Open a tab:
curl -sf -X POST -H 'Content-Type: application/json' \
  -d '{"userId":"claude","sessionKey":"default","url":"http://127.0.0.1:8787/"}' \
  http://127.0.0.1:9377/tabs | jq -r '.tabId' > /tmp/tab.id
TAB=$(cat /tmp/tab.id)

# Install a high-latency fault:
curl -sf -X POST -H 'Content-Type: application/json' \
  -d "{\"userId\":\"claude\",\"mode\":\"high_latency\",\"latencyMs\":1500}" \
  http://127.0.0.1:9377/tabs/$TAB/network-fault | jq

# Read in-flight requests during a mutation:
curl -sf "http://127.0.0.1:9377/tabs/$TAB/in-flight-requests?userId=claude" | jq

# Install a Date polyfill:
curl -sf -X POST -H 'Content-Type: application/json' \
  -d "{\"userId\":\"claude\",\"script\":\"Date.now = () => 1735689600000;\"}" \
  http://127.0.0.1:9377/tabs/$TAB/init-script | jq

# Set timezone:
curl -sf -X POST -H 'Content-Type: application/json' \
  -d "{\"userId\":\"claude\",\"id\":\"Asia/Tokyo\"}" \
  http://127.0.0.1:9377/tabs/$TAB/timezone | jq

# Clear everything:
curl -sf -X POST -d '{"userId":"claude"}' http://127.0.0.1:9377/tabs/$TAB/clear-network-fault | jq
curl -sf -X POST -d '{"userId":"claude"}' http://127.0.0.1:9377/tabs/$TAB/clear-init-scripts | jq
curl -sf -X POST -d '{"userId":"claude"}' http://127.0.0.1:9377/tabs/$TAB/clear-timezone | jq
```

…and from a Claude session (after the matching MCP wrappers ship in `camofox-mcp/SPEC_BUGHUNTER_INTEGRATION.md`):

- BugHunter V20 produces non-empty `byKind` counts for `network_fault_*` BugKinds.
- BugHunter V22's `interimState.inFlightRequests` is a non-empty array on at least one occurrence.
- BugHunter V23 produces non-empty `byKind` counts for `time_clock_*` BugKinds.

---

## 10. Open Questions

1. **Should `timeout_at_response` use a 120 s ceiling or the per-test `asyncMaxWaitMs`?** Current spec says 120 s. BugHunter's per-test timeout is 30 s. A 120 s server-side stall guarantees the test hits its 30 s ceiling and reports the timeout. But if the per-test ceiling is later raised, a 120 s server stall may not be enough. Should the server read the timeout from the request body? Defer until V20 surfaces an actual case.

2. **Is `unrouteAll({ behavior: 'wait' })` the right teardown?** Alternatives: `'ignoreErrors'` (drops handlers immediately, in-flight handler invocations may throw) or `'default'` (drops + best-effort wait). `'wait'` is safest; the cost is a small delay on `clear-network-fault` proportional to the number of in-flight handler invocations. Need to verify the delay is bounded — Playwright docs aren't crystal clear. Plan B: `'ignoreErrors'` if `'wait'` causes test flakiness.

3. **Should the in-flight tracker include `requestId` (a stable identity for the request across `request` / `response` / `requestfinished`)?** Useful for V22 if it ever wants to correlate a specific in-flight request across the boundary. Playwright's `Request` is identity-comparable but not serialisable; we'd need to mint our own UUID per request. Not required by V22 today; defer.

4. **Init-script `id` collision policy: 409, replace, or auto-rename?** Current spec: 409. Alternative: silently replace (last-wins). Replacement matches `addInitScript`'s semantics for the *script value*, but our id-based registry would lose the prior disposable handle. 409 is safer; deferred to coder to decide if 409 is annoying in practice.

5. **Timezone allow-list.** Current spec validates IANA `Continent/City` regex. Should we instead enumerate every IANA zone (~600 entries, embedded as a Set)? Strict allow-list catches typos but bloats the bundle. Current loose regex catches obvious garbage; passes through the polyfill renderer which will fail loudly if `Intl` rejects the zone. Loose regex is preferred unless a pen-tester surfaces an injection vector.

6. **Should `POST /timezone` and `POST /init-script` share the same `id` namespace?** Currently yes — `tabState.initScripts` is one Map and `timezoneInitScriptId` indexes into it. This is correct but means a caller could `clear-init-scripts` and accidentally clear the timezone polyfill. Spec'd but slightly footgun-y. Alternative: separate Maps. Defer.

7. **Should the polyfill template inline a third-party library (e.g. `timezone-mock`, ~3 KB) or be hand-rolled?** Hand-rolled keeps zero dependencies on the browser side. `timezone-mock` is well-tested but patches a smaller subset (`getTimezoneOffset` only — no `Intl.DateTimeFormat`). Spec leans hand-rolled; coder decides at implementation time and updates the spec via a follow-up if a library is materially better.
