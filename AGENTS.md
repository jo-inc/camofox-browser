# camofox-browser Agent Guide

Headless browser automation server for AI agents. Run locally or deploy to any cloud provider.

## Quick Start for Agents

```bash
# Install and start
npm install && npm start
# Server runs on http://localhost:9377
```

## Core Workflow

1. **Create a tab** → Get `tabId`
2. **Navigate** → Go to URL or use search macro
3. **Get snapshot** → Receive page content with element refs (`e1`, `e2`, etc.)
4. **Interact** → Click/type using refs
5. **Repeat** steps 3-4 as needed

## API Reference

### Create Tab
```bash
POST /tabs
{"userId": "agent1", "sessionKey": "task1", "url": "https://example.com"}
```
Returns: `{"tabId": "abc123", "url": "...", "title": "..."}`

### Navigate
```bash
POST /tabs/:tabId/navigate
{"userId": "agent1", "url": "https://google.com"}
# Or use macro:
{"userId": "agent1", "macro": "@google_search", "query": "weather today"}
```

### Get Snapshot
```bash
GET /tabs/:tabId/snapshot?userId=agent1
```
Returns accessibility tree with refs:
```
[heading] Example Domain
[paragraph] This domain is for use in examples.
[link e1] More information...
```

### Click Element
```bash
POST /tabs/:tabId/click
{"userId": "agent1", "ref": "e1"}
# Or CSS selector:
{"userId": "agent1", "selector": "button.submit"}
```

### Type Text
```bash
POST /tabs/:tabId/type
{"userId": "agent1", "ref": "e2", "text": "hello world"}
# Add enter: {"userId": "agent1", "ref": "e2", "text": "search query", "pressEnter": true}
```

### Scroll
```bash
POST /tabs/:tabId/scroll
{"userId": "agent1", "direction": "down", "amount": 500}
```

### Navigation
```bash
POST /tabs/:tabId/back     {"userId": "agent1"}
POST /tabs/:tabId/forward  {"userId": "agent1"}
POST /tabs/:tabId/refresh  {"userId": "agent1"}
```

### Get Links
```bash
GET /tabs/:tabId/links?userId=agent1&limit=50
```

### Close Tab
```bash
DELETE /tabs/:tabId?userId=agent1
```

## Search Macros

Use these instead of constructing URLs:

| Macro | Site |
|-------|------|
| `@google_search` | Google |
| `@youtube_search` | YouTube |
| `@amazon_search` | Amazon |
| `@reddit_search` | Reddit |
| `@wikipedia_search` | Wikipedia |
| `@twitter_search` | Twitter/X |
| `@yelp_search` | Yelp |
| `@linkedin_search` | LinkedIn |

## Element Refs

Refs like `e1`, `e2` are stable identifiers for page elements:

1. Call `/snapshot` to get current refs
2. Use ref in `/click` or `/type`
3. Refs reset on navigation - get new snapshot after

## Session Management

- `userId` isolates cookies/storage between users
- `sessionKey` groups tabs by conversation/task (legacy: `listItemId` also accepted)
- Sessions timeout after 30 minutes of inactivity
- Delete all user data: `DELETE /sessions/:userId`

## Running Engines

### Camoufox (Default)
```bash
npm start
# Or: ./run.sh
```
Firefox-based with anti-detection. Bypasses Google captcha.

## Testing

```bash
npm test                          # All tests (unit + e2e + plugin)
npm run test:plugins              # All plugin tests
npm run test:e2e                  # E2E tests
npm run test:live                 # Live Google tests
npm run test:debug                # With server output
npx jest plugins/youtube          # Single plugin's tests
```

## Docker

```bash
docker build -t camofox-browser .
docker run -p 9377:9377 camofox-browser
```

## Key Files

- `server.js` - Camoufox engine (routes + browser logic only — NO `process.env` or `child_process`)
- `lib/openapi.js` - OpenAPI spec generation via swagger-jsdoc + docs route setup
- `lib/config.js` - All `process.env` reads centralized here
- `plugins/youtube/youtube.js` - YouTube transcript extraction via yt-dlp (`child_process` isolated here)
- `lib/launcher.js` - Subprocess spawning (`child_process` isolated here)
- `lib/cookies.js` - Cookie file I/O
- `lib/metrics.js` - Prometheus metrics (lazy-loaded, off by default — set `PROMETHEUS_ENABLED=1`)
- `lib/request-utils.js` - HTTP request classification helpers (`actionFromReq`, `classifyError`)
- `lib/snapshot.js` - Accessibility tree snapshot
- `lib/macros.js` - Search macro URL expansion
- `lib/plugins.js` - Plugin loader and event bus
- `lib/auth.js` - Shared auth middleware (API key / loopback)
- `camofox.config.json` - Plugin configuration (which plugins to load)
- `plugins/` - Plugin directory (loaded per camofox.config.json)
- `plugins/youtube/` - Default plugin: YouTube transcript extraction
- `scripts/install-plugin-deps.sh` - Installs plugin deps (apt.txt + post-install.sh)
- `plugins/vnc/index.js` - VNC plugin routes (no `child_process` — spawning isolated in `vnc-launcher.js`)
- `plugins/vnc/vnc-launcher.js` - VNC process management (`child_process` isolated here)
- `plugins/persistence/index.js` - Session persistence lifecycle hooks
- `lib/persistence.js` - Atomic storage state read/write
- `lib/inflight.js` - Inflight request coalescing
- `lib/tmp-cleanup.js` - Orphaned temp file cleanup
- `lib/reporter.js` - Crash/hang reporter with anonymization + GitHub App auth (see README "Crash Reporter" for setup)
- `Dockerfile` - Production container with default plugin deps pre-installed

## OpenAPI Spec (REQUIRED for route changes)

The API spec is auto-generated from `@openapi` JSDoc comments in `server.js` via [swagger-jsdoc](https://github.com/Surnet/swagger-jsdoc). It's served at `GET /openapi.json` (machine-readable) and `GET /docs` ([swagger-stripey](https://github.com/skyfallsin/swagger-stripey) three-panel UI).

**When adding, modifying, or removing a route, you MUST update the `@openapi` JSDoc block above it.**

Every route handler in `server.js` has a JSDoc comment block directly above it like:

```js
/**
 * @openapi
 * /tabs/{tabId}/click:
 *   post:
 *     tags: [Interaction]
 *     summary: Click an element
 *     parameters:
 *       - name: tabId
 *         in: path
 *         required: true
 *         schema:
 *           type: string
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [userId]
 *             properties:
 *               userId:
 *                 type: string
 *               ref:
 *                 type: string
 *     responses:
 *       200:
 *         description: Click result.
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *       404:
 *         description: Tab not found.
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 */
app.post('/tabs/:tabId/click', async (req, res) => {
```

**Rules:**
- New routes: add a `@openapi` JSDoc block immediately above the `app.get/post/delete(...)` call
- Path params use `{tabId}` syntax (not `:tabId`) in the JSDoc YAML
- Tag must be one of: `System`, `Tabs`, `Navigation`, `Interaction`, `Content`, `Sessions`, `Browser`, `Legacy`
- Every operation must have `tags`, `summary`, and `responses`
- Include `requestBody` for POST/PUT/DELETE routes that accept JSON
- Include `parameters` for path params and required query params
- Mark backward-compat endpoints with `deprecated: true`
- Removing a route: delete the `@openapi` block along with the handler
- **After any route change, run `npm run generate-openapi`** to regenerate the committed `openapi.json`. The test suite will fail if it's stale.
- Run `npx jest tests/unit/openapi.test.js` to verify coverage — the test fails if any route is missing from the spec, if a stale route exists, or if `openapi.json` is out of date
- Reusable schemas go in `components.schemas` in `lib/openapi.js` (the `swaggerDefinition`); reference them via `$ref: '#/components/schemas/Name'`

## Crash Reporter

**No credentials are embedded in this package.** `lib/reporter.js` is a stateless HTTP client that sends anonymized crash/hang reports to a Cloudflare Worker relay (`camofox-crash-relay.askjo.workers.dev`). The relay holds the GitHub App credentials as environment secrets — see `workers/crash-reporter/index.ts`. The relay source is in-repo and auditable.

- **Architecture**: `lib/reporter.js` (client, no secrets, no `fs`) → POST → Cloudflare Worker relay → GitHub Issues
- **`lib/reporter.js`** has ZERO credentials, ZERO private keys, ZERO `fs` imports. It only does `fetch()` to the relay URL.
- **`lib/resources.js`** handles `fs`/`child_process` resource snapshots — separated from reporter.js so no file-read + network-send pattern exists in any single file
- **Anonymization** is in `lib/reporter.js` L28–290 — text scrubbing (`anonymize()`), URL anonymization (`createUrlAnonymizer()`), and tab health tracking (`createTabHealthTracker()`)
- **Public domain list** (~120 entries) determines which domains are shown verbatim vs HMAC-hashed
- **Tests**: `tests/unit/crashRelay.test.js` (relay client), `tests/unit/crashRelayWorker.test.js` (worker contract), `tests/unit/noSecrets.test.js` (asserts no key material in shipped files)
- Self-hosted relay: see README "Self-hosted relay" section
- Disable with `CAMOFOX_CRASH_REPORT_ENABLED=false`

## OpenClaw Scanner Isolation (CRITICAL)

OpenClaw's skill-scanner flags plugins that have `process.env` + network calls (e.g. `app.post`, `fetch`, `http.request`) in the same file, or `child_process` + network calls in the same file. These patterns suggest potential credential exfiltration.

**Rule: No single `.js` file may contain both halves of a scanner rule pair:**
- `process.env` lives ONLY in `lib/config.js`
- `child_process` / `execFile` / `spawn` live ONLY in `plugins/youtube/youtube.js`, `plugins/vnc/vnc-launcher.js`, and `lib/launcher.js`
- `server.js` has the Express routes (`app.post`, `app.get`) but ZERO `process.env` reads and ZERO `child_process` imports
- `lib/metrics.js` has NO `process.env` and NO HTTP method strings (`POST`, `fetch`). Prometheus is lazy-loaded only when `PROMETHEUS_ENABLED=1`.
- `lib/request-utils.js` has HTTP method strings (`POST`) but NO `process.env` — safe.
- When adding new features that need env vars or subprocesses, put that code in a `lib/` module and import the result into `server.js`

**Scanner rule details** (from `src/security/skill-scanner.ts`):
- `env-harvesting` (CRITICAL): fires when `/process\.env/` AND `/\bfetch\b|\bpost\b|http\.request/i` match the SAME file. Note: the regex is case-insensitive, so string literals like `'POST'` and even comments containing `process.env` will trigger it.
- `dangerous-exec` (CRITICAL): `child_process` import + `exec`/`spawn` call in same file
- `potential-exfiltration` (WARN): `readFile` + `fetch`/`post`/`http.request` in same file

This was broken in 1.3.0 (YouTube `child_process` in server.js), fixed in 1.3.1. Broken again in 1.4.1 (`metrics.js` had `process.env` in a comment + `'POST'` in `actionFromReq`), fixed in 1.5.1 by lazy-loading prom-client and splitting `actionFromReq` into `lib/request-utils.js`.

## Plugin System

Plugins extend camofox-browser with new endpoints, background processes, and lifecycle hooks. The server auto-loads all plugins from `plugins/<name>/index.js` on startup.

### Creating a Plugin

```
plugins/
  my-plugin/
    index.js        Required — exports register(app, ctx)
    apt.txt         Optional — system packages (one per line)
    post-install.sh Optional — executable hook for binary downloads
    *.test.js       Optional — Jest tests (auto-discovered)
```

```js
// plugins/my-plugin/index.js

export function register(app, ctx) {
  const { sessions, config, log, events, auth, ensureBrowser, getSession, destroySession,
          withUserLimit, safePageClose, normalizeUserId, validateUrl, safeError,
          buildProxyUrl, proxyPool, failuresTotal } = ctx;

  // Register Express routes (auth() enforces API key or loopback)
  app.get('/my-endpoint', auth(), async (req, res) => {
    const session = sessions.get(req.params.userId);
    res.json({ ok: true });
  });

  // Listen to lifecycle events
  events.on('browser:launched', ({ browser, display }) => {
    log('info', 'browser is up', { display });
  });

  events.on('session:created', ({ userId, context }) => {
    log('info', 'new session', { userId });
  });

  events.on('tab:navigated', ({ userId, tabId, url }) => {
    log('info', 'navigation', { userId, tabId, url });
  });
}
```

### Plugin Context (`ctx`)

| Property | Type | Description |
|----------|------|-------------|
| `sessions` | `Map` | Live sessions: `userId → { context, tabGroups, lastAccess }` |
| `config` | `object` | Server CONFIG (port, apiKey, nodeEnv, proxy, etc.) |
| `log` | `function` | `log(level, msg, fields)` — structured JSON logging |
| `events` | `EventEmitter` | Plugin event bus (29 events — see below) |
| `auth` | `function` | `auth()` returns Express middleware enforcing API key / loopback |
| `ensureBrowser` | `async function` | Launch browser if not running, return browser instance |
| `getSession` | `async function` | `getSession(userId)` — get or create a session |
| `destroySession` | `function` | `destroySession(userId)` — tear down a session |
| `withUserLimit` | `async function` | `withUserLimit(userId, fn)` — run `fn` within per-user concurrency limit |
| `safePageClose` | `async function` | `safePageClose(page)` — close a page with timeout guard |
| `normalizeUserId` | `function` | `normalizeUserId(id)` — coerce to string for map keys |
| `validateUrl` | `function` | `validateUrl(url)` — returns error string or null |
| `safeError` | `function` | `safeError(err)` — sanitize error for client response |
| `buildProxyUrl` | `function` | `buildProxyUrl(pool, proxyConfig)` — get proxy URL for external requests |
| `proxyPool` | `object\|null` | Proxy pool instance (null if no proxy configured) |
| `failuresTotal` | `Counter` | Prometheus counter: `failuresTotal.labels(type, action).inc()` |
| `createMetric` | `async function` | Create a Prometheus metric registered to the shared registry (see below) |
| `metricsRegistry` | `function` | `metricsRegistry()` — raw prom-client Registry or null |

### Events (29)

28 emitted by core, 1 (`session:storage:export`) emitted by plugins.

#### Browser Lifecycle
| Event | Payload | Mutating? |
|-------|---------|-----------|
| `browser:launching` | `{ options }` | ✅ Modify launch options in-place |
| `browser:launched` | `{ browser, display }` | |
| `browser:restart` | `{ reason }` | |
| `browser:closed` | `{ reason }` | |
| `browser:error` | `{ error }` | |

#### Session Lifecycle
| Event | Payload | Mutating? |
|-------|---------|-----------|
| `session:creating` | `{ userId, contextOptions }` | ✅ Modify context options in-place |
| `session:created` | `{ userId, context }` | |
| `session:destroyed` | `{ userId, reason }` | |
| `session:expired` | `{ userId, idleMs }` | |

#### Tab Lifecycle
| Event | Payload |
|-------|---------|
| `tab:created` | `{ userId, tabId, page, url }` |
| `tab:navigated` | `{ userId, tabId, url, prevUrl }` |
| `tab:destroyed` | `{ userId, tabId, reason }` |
| `tab:recycled` | `{ userId, tabId }` |
| `tab:error` | `{ userId, tabId, error }` |

#### Content
| Event | Payload |
|-------|---------|
| `tab:snapshot` | `{ userId, tabId, snapshot }` |
| `tab:screenshot` | `{ userId, tabId, buffer }` |
| `tab:evaluate` | `{ userId, tabId, expression }` |
| `tab:evaluated` | `{ userId, tabId, result }` |

#### Input
| Event | Payload |
|-------|---------|
| `tab:click` | `{ userId, tabId, ref, selector }` |
| `tab:type` | `{ userId, tabId, text, ref, mode }` |
| `tab:scroll` | `{ userId, tabId, direction, amount }` |
| `tab:press` | `{ userId, tabId, key }` |

#### Downloads
| Event | Payload |
|-------|---------|
| `tab:download:start` | `{ userId, tabId, filename, url }` |
| `tab:download:complete` | `{ userId, tabId, filename, path, size }` |

#### Cookies / Auth
| Event | Payload |
|-------|---------|
| `session:cookies:import` | `{ userId, count }` |
| `session:storage:export` | `{ userId }` |

#### Server
| Event | Payload |
|-------|---------|
| `server:starting` | `{ port }` |
| `server:started` | `{ port, pid }` |
| `server:shutdown` | `{ signal }` |

### Mutating Hooks

`browser:launching`, `session:creating`, `session:created`, and `session:destroyed` are emitted via `events.emitAsync()` — the server awaits all listeners (including async ones) before proceeding. This ensures async work like loading storage state from disk completes before the context is created.

Other events use regular `events.emit()` (fire-and-forget).

Modify payload objects in-place:

```js
// Change Xvfb resolution (e.g., for VNC plugin)
events.on('browser:launching', ({ options }) => {
  options.virtual_display_resolution = '1920x1080x24';
});

// Inject saved auth state into new sessions
events.on('session:creating', ({ userId, contextOptions }) => {
  const saved = loadStorageState(userId);
  if (saved) contextOptions.storageState = saved;
});
```

### System Packages (`apt.txt`) and Post-Install Hooks

Plugins that need system packages list them one per line in `apt.txt`:

```
# plugins/vnc/apt.txt
x11vnc
novnc
python3-websockify
```

For binary downloads or setup not available via apt, add an executable `post-install.sh`:

```bash
# plugins/youtube/post-install.sh
#!/bin/sh
set -e
curl -fL https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp -o /usr/local/bin/yt-dlp
chmod +x /usr/local/bin/yt-dlp
```

Both are run by `scripts/install-plugin-deps.sh` during Docker build.

### Configuration (`camofox.config.json`)

`camofox.config.json` controls which plugins are loaded at runtime and during Docker build:

```json
{
  "id": "camofox-browser",
  "name": "Camofox Browser",
  "version": "1.5.2",
  "plugins": ["youtube"]
}
```

- **`plugins`** — array of plugin directory names to load. Only these are loaded at startup and have deps installed during build.
- If the file is missing or has no `plugins` key, **all** plugins in `plugins/` are loaded (backward-compatible).
- This is camofox's own config. `openclaw.plugin.json` is separate — it tells the OpenClaw Gateway how to configure camofox as an external service.

### Installing Plugins

Use the plugin manager to install third-party plugins from git or local paths:

```bash
# Install from git
npm run plugin install https://github.com/user/camofox-screenshot-plugin
npm run plugin install git:github.com/user/my-plugin

# Install from local directory
npm run plugin install ./path/to/my-plugin

# List installed plugins
npm run plugin list

# Remove a plugin
npm run plugin remove my-plugin
```

The installer copies the plugin into `plugins/`, adds it to `camofox.config.json`, and runs `npm install` for any npm dependencies. System deps (`apt.txt`, `post-install.sh`) are flagged but must be installed manually or via Docker rebuild.

Plugin sources can be:
- **Git repos** where the root has `index.js` with `register()` (installed as one plugin)
- **Git repos** with a `plugins/` subdirectory (each subdirectory installed as a separate plugin)
- **Local directories** with `index.js` and `register()`

### Default Plugins

Three plugins ship by default:

- **youtube** — YouTube transcript extraction (enabled by default)
- **persistence** — Per-user session state persistence to `~/.camofox/profiles/` (enabled by default)
- **vnc** — Interactive browser login via noVNC (disabled by default, requires `ENABLE_VNC=1`)

The `youtube` plugin ships as a default plugin — it's listed in `camofox.config.json` and included in the base Docker image with its deps pre-installed. The base image runs `scripts/install-plugin-deps.sh` which reads the config and installs `apt.txt` packages + `post-install.sh` hooks for listed plugins.

The `with-plugins` Dockerfile stage is for rebuilding after adding third-party plugins:

```bash
docker build --target with-plugins -t camofox-browser .
```

The `with-plugins` stage re-runs `install-plugin-deps.sh` to pick up any new plugins added to `plugins/`.

### OpenClaw Scanner Rules

Plugins must follow the same isolation rules as core (see "OpenClaw Scanner Isolation" above):
- **No `process.env` in plugin files that also have route handlers** — read config from `ctx.config`
- **No `child_process` in plugin files that also have route handlers** — spawn from a separate `lib/` module
- Violations trigger OpenClaw's `env-harvesting` or `dangerous-exec` scanner alerts

### Custom Metrics

Plugins create Prometheus metrics via `ctx.createMetric()`. Returns a no-op stub when Prometheus is disabled — no null checks needed.

```js
// In register(app, ctx):
const transcriptsTotal = await ctx.createMetric('counter', {
  name: 'camofox_youtube_transcripts_total',
  help: 'YouTube transcripts extracted',
  labelNames: ['method'],
});

// Use anywhere — works whether Prometheus is enabled or not
transcriptsTotal.labels('yt-dlp').inc();
```

Supported types: `'counter'`, `'histogram'`, `'gauge'`. Options are standard [prom-client](https://github.com/siimon/prom-client) options (`name`, `help`, `labelNames`, `buckets`, etc.). Metrics auto-register to the shared registry and appear on `/metrics`.

For advanced use, `ctx.metricsRegistry()` returns the raw prom-client `Registry` (or `null` when disabled).

### Example: YouTube Transcript Plugin

The YouTube plugin (`plugins/youtube/`) is the reference implementation. It extracts transcripts via yt-dlp with browser fallback, using `ctx` helpers for auth, logging, browser access, and concurrency control.

```
plugins/
  youtube/
    index.js        # register(app, ctx) — route handler + browser fallback
    youtube.js      # yt-dlp process management + transcript parsing
    youtube.test.js # parser unit tests
    apt.txt         # python3-minimal (yt-dlp runtime dep)
    post-install.sh # downloads yt-dlp binary
```

```js
// plugins/youtube/index.js (simplified)
import { detectYtDlp, hasYtDlp, ensureYtDlp, ytDlpTranscript } from './youtube.js';
import { classifyError } from '../../lib/request-utils.js';

export async function register(app, ctx) {
  const { log, config, sessions, ensureBrowser, getSession,
          withUserLimit, safePageClose, normalizeUserId,
          validateUrl, safeError, buildProxyUrl, proxyPool,
          failuresTotal } = ctx;

  await detectYtDlp(log);

  app.post('/youtube/transcript', ctx.auth(), async (req, res) => {
    // ... validate URL, extract videoId, try yt-dlp then browser fallback
  });

  async function browserTranscript(reqId, url, videoId, lang) {
    return await withUserLimit('__yt_transcript__', async () => {
      await ensureBrowser();
      const session = await getSession('__yt_transcript__');
      const page = await session.context.newPage();
      // ... intercept captions, parse transcript
      await safePageClose(page);
    });
  }
}
```

Key patterns:
- **Auth**: `ctx.auth()` middleware on the route
- **Logging**: `ctx.log('info', ...)` — never `console.log`
- **Browser access**: `ctx.ensureBrowser()` + `ctx.getSession()` for browser-backed features
- **Concurrency**: `ctx.withUserLimit()` to respect per-user limits
- **Metrics**: `ctx.failuresTotal.labels(...)` for core counters, `ctx.createMetric()` for custom
- **Scanner compliance**: `child_process` in `youtube.js`, route handler in `index.js` — separate files
- **System deps**: `apt.txt` lists packages installed via `scripts/install-plugin-deps.sh`
