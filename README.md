<div align="center">
  <img src="fox.png" alt="camofox-browser" width="200" />
  <h1>camofox-browser</h1>
  <p><strong>Anti-detection browser server for AI agents, powered by Camoufox</strong></p>
  <p>
    <a href="LICENSE"><img src="https://img.shields.io/badge/License-MIT-yellow.svg" alt="License: MIT" /></a>
    <a href="https://github.com/jo-inc/camofox-browser/stargazers"><img src="https://img.shields.io/github/stars/jo-inc/camofox-browser" alt="GitHub stars" /></a>
    <a href="https://www.npmjs.com/package/camofox-browser"><img src="https://img.shields.io/npm/v/camofox-browser" alt="npm version" /></a>
    <a href="https://github.com/jo-inc/camofox-browser/commits"><img src="https://img.shields.io/github/last-commit/jo-inc/camofox-browser" alt="GitHub last commit" /></a>
  </p>
  <p>
    Standing on the mighty shoulders of <a href="https://camoufox.com">Camoufox</a> - a Firefox fork with fingerprint spoofing at the C++ level.
  </p>
</div>

<br/>

> <a href="https://askjo.ai?ref=camofox"><img src="jo-logo.png" alt="Jo" width="80" height="80" align="left" /></a>
>
> Built by the team behind <a href="https://askjo.ai?ref=camofox"><strong>jo -- a personal AI agent</strong></a> that runs half on your Mac, half on a dedicated cloud machine just for you -- with zero maintenance needed. Available on macOS, Telegram, WhatsApp, and email. <a href="https://askjo.ai?ref=camofox">Try the beta free -></a>

<br/>

```bash
git clone https://github.com/jo-inc/camofox-browser && cd camofox-browser
npm install && npm start
# -> http://localhost:9377
```

---

## Why

AI agents need to browse the real web. Playwright gets blocked. Headless Chrome gets fingerprinted. Stealth plugins become the fingerprint.

Camoufox patches Firefox at the **C++ implementation level** - `navigator.hardwareConcurrency`, WebGL renderers, AudioContext, screen geometry, WebRTC - all spoofed before JavaScript ever sees them. No shims, no wrappers, no tells.

This project wraps that engine in a REST API built for agents: accessibility snapshots instead of bloated HTML, stable element refs for clicking, and search macros for common sites.

## Features

- **C++ Anti-Detection** - bypasses Google, Cloudflare, and most bot detection
- **Element Refs** - stable `e1`, `e2`, `e3` identifiers for reliable interaction
- **Token-Efficient** - accessibility snapshots are ~90% smaller than raw HTML
- **Runs on Anything** - lazy browser launch + idle shutdown keeps memory at ~40MB when idle. Designed to share a box with the rest of your stack -- Raspberry Pi, $5 VPS, shared infra.
- **Session Isolation** - separate cookies/storage per user
- **Cookie Import** - inject Netscape-format cookie files for authenticated browsing
- **Proxy + GeoIP** - route traffic through residential proxies with automatic locale/timezone
- **Structured Logging** - JSON log lines with request IDs for production observability
- **YouTube Transcripts** - extract captions from any YouTube video via yt-dlp, no API key needed
- **Search Macros** - `@google_search`, `@youtube_search`, `@amazon_search`, `@reddit_subreddit`, and 10 more
- **Snapshot Screenshots** - include a base64 PNG screenshot alongside the accessibility snapshot
- **Large Page Handling** - automatic snapshot truncation with offset-based pagination
- **Download Capture** - capture browser downloads and fetch them via API (optional inline base64)
- **DOM Image Extraction** - list `<img>` src/alt and optionally return inline data URLs
- **Deploy Anywhere** - Docker, Fly.io, Railway
- **VNC Interactive Login** - log into sites visually via noVNC, export storage state for agent reuse
- **OpenAPI Docs** - auto-generated spec at [`/openapi.json`](http://localhost:9377/openapi.json) and interactive docs at [`/docs`](http://localhost:9377/docs)
- **Structured Extract** - `POST /tabs/:tabId/extract` with a JSON Schema that maps properties to snapshot refs via `x-ref`
- **Session Tracing** - opt-in per-session Playwright trace capture (screenshots + DOM snapshots + network) with API endpoints to list, fetch, and delete trace zips
- **Telemetry** - automatic [anonymized crash/hang telemetry](lib/reporter.js#L28-L290) via GitHub Issues. Identifies which sites cause failures and common failure patterns. Private domains are HMAC-hashed, paths/params stripped, tokens/IPs redacted. Opt-out with `CAMOFOX_CRASH_REPORT_ENABLED=false`.

## Optional Dependencies

| Dependency | Purpose | Install |
|-----------|---------|---------|
| [yt-dlp](https://github.com/yt-dlp/yt-dlp) | YouTube transcript extraction (fast path) | `pip install yt-dlp` or `brew install yt-dlp` |

The Docker image includes yt-dlp. For local dev, install it for the `/youtube/transcript` endpoint. Without it, the endpoint falls back to a slower browser-based method.

## Quick Start

### OpenClaw Plugin

```bash
openclaw plugins install @askjo/camofox-browser
```

**Tools:** `camofox_create_tab`  |  `camofox_snapshot`  |  `camofox_click`  |  `camofox_type`  |  `camofox_navigate`  |  `camofox_scroll`  |  `camofox_screenshot`  |  `camofox_close_tab`  |  `camofox_list_tabs`  |  `camofox_import_cookies`

### Standalone

```bash
git clone https://github.com/jo-inc/camofox-browser
cd camofox-browser
npm install
npm start  # downloads Camoufox on first run (~300MB)
```

Default port is `9377`. See [Environment Variables](#environment-variables) for all options.

> **Note:** the postinstall script unsets `PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD` for itself before fetching the Camoufox binary. Without that override, an exported `PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1` (common when Playwright is configured to use system Chrome) would silently skip the binary download and crash the server at runtime.
>
> **Air-gapped or custom binary management:** disable the auto-fetch with `npm install --ignore-scripts` (skips lifecycle scripts for *every* dependency — bluntest option) or, more surgically, `npm install --omit=optional` plus a manual `npx camoufox-js fetch` step against your mirror. Note that `PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 npm install` no longer skips the Camoufox download (the postinstall sanitizes the env locally); use `--ignore-scripts` for that.

### Docker

The included `Makefile` auto-detects your CPU architecture and pre-downloads Camoufox + yt-dlp binaries outside the Docker build, so rebuilds are fast (~30s vs ~3min).

```bash
# Build and start (auto-detects arch: aarch64 on M1/M2, x86_64 on Intel)
make up

# Stop and remove the container
make down

# Force a clean rebuild (e.g. after upgrading VERSION/RELEASE)
make reset

# Just download binaries (without building)
make fetch

# Override arch or version explicitly
make up ARCH=x86_64
make up VERSION=135.0.1 RELEASE=beta.24
```

> **WARNING: Do not run `docker build` directly.** The Dockerfile uses bind mounts to pull pre-downloaded binaries from `dist/`. Always use `make up` (or `make fetch` then `make build`) -- it downloads the binaries first.

### Fly.io

For Fly.io or other remote CI, you'll need a Dockerfile that downloads binaries at build time instead of using bind mounts.

### Railway

A `railway.toml` is included. It uses `Dockerfile.ci` (which downloads binaries at build time) and maps Railway's `PORT` env var to `CAMOFOX_PORT` automatically.

```bash
# Install Railway CLI, then:
railway link
railway up
```

Set secrets via the Railway dashboard or CLI:
```bash
railway variables set CAMOFOX_API_KEY="your-generated-key"
```

## Usage

### Cookie Import

Import cookies from your browser into Camoufox to skip interactive login on sites like LinkedIn, Amazon, etc.

#### Setup

**1. Generate a secret key:**

```bash
# macOS / Linux
openssl rand -hex 32
```

**2. Set the environment variable before starting OpenClaw:**

```bash
export CAMOFOX_API_KEY="your-generated-key"
openclaw start
```

The same key is used by both the plugin (to authenticate requests) and the server (to verify them). Both run from the same environment -- set it once.

> **Why an env var?** The key is a secret. Plugin config in `openclaw.json` is stored in plaintext, so secrets don't belong there. Set `CAMOFOX_API_KEY` in your shell profile, systemd unit, Docker env, or Fly.io secrets.

> **Cookie import is disabled by default.** If `CAMOFOX_API_KEY` is not set, the server rejects all cookie requests with 403.

**3. Export cookies from your browser:**

Install a browser extension that exports Netscape-format cookie files (e.g., "cookies.txt" for Chrome/Firefox). Export the cookies for the site you want to authenticate.

**4. Place the cookie file:**

```bash
mkdir -p ~/.camofox/cookies
cp ~/Downloads/linkedin_cookies.txt ~/.camofox/cookies/linkedin.txt
```

The default directory is `~/.camofox/cookies/`. Override with `CAMOFOX_COOKIES_DIR`.

**5. Ask your agent to import them:**

> Import my LinkedIn cookies from linkedin.txt

The agent calls `camofox_import_cookies` -> reads the file -> POSTs to the server with the Bearer token -> cookies are injected into the browser session. Subsequent `camofox_create_tab` calls to linkedin.com will be authenticated.

#### How it works

```
~/.camofox/cookies/linkedin.txt          (Netscape format, on disk)
        |
        v
camofox_import_cookies tool              (parses file, filters by domain)
        |
        v  POST /sessions/:userId/cookies
        |  Authorization: Bearer <CAMOFOX_API_KEY>
        |  Body: { cookies: [Playwright cookie objects] }
        v
camofox server                           (validates, sanitizes, injects)
        |
        v  context.addCookies(...)
        |
Camoufox browser session                 (authenticated browsing)
```

- `cookiesPath` is resolved relative to the cookies directory -- path traversal outside it is blocked
- Max 500 cookies per request, 5MB file size limit
- Cookie objects are sanitized to an allowlist of Playwright fields

### Session Persistence

By default, camofox persists each user's cookies and localStorage to `~/.camofox/profiles/`. Sessions survive browser restarts -- log in once (via cookies or VNC), and subsequent sessions restore the authenticated state automatically.

```
~/.camofox/
|-- cookies/          # Bootstrap cookie files (Netscape format)
\-- profiles/         # Persisted session state (auto-managed)
    \-- <hashed-userId>/
        \-- storage_state.json
```

Override the directory with `CAMOFOX_PROFILE_DIR` or set `"profileDir"` in the persistence plugin config. To disable persistence, set `"persistence": { "enabled": false }` in `camofox.config.json`.

### Session Tracing

Capture a Playwright trace of every action in a session: page screenshots, DOM snapshots, network requests, and console output. Output is a single `.zip` file you can open in Playwright's built-in Trace Viewer.

Opt-in per session by passing `trace: true` when opening the first tab:

```bash
curl -X POST http://localhost:9377/tabs \
  -H 'Content-Type: application/json' \
  -d '{"userId":"agent1","sessionKey":"task1","url":"https://example.com","trace":true}'
```

The trace is written when the session closes. Close the session to flush it, then list, fetch, and view:

```bash
# Close the session to flush the trace
curl -X DELETE http://localhost:9377/sessions/agent1

# List trace files
curl http://localhost:9377/sessions/agent1/traces
# {"traces":[{"filename":"trace-2026-04-18T04-05-00-...zip","sizeBytes":42810,"createdAt":...}]}

# Download (Content-Type: application/zip)
curl http://localhost:9377/sessions/agent1/traces/trace-2026-04-18T04-05-00-abc.zip > session.zip

# View it in Playwright's Trace Viewer
npx playwright show-trace session.zip

# Delete
curl -X DELETE http://localhost:9377/sessions/agent1/traces/trace-2026-04-18T04-05-00-abc.zip
```

Why traces instead of video: Camoufox is Firefox-based, and Playwright's `recordVideo` is Chromium-only. Traces work on Firefox and give you more than video (network + DOM + console + screenshots).

Tracing cannot be toggled on an existing session. `DELETE /sessions/:userId` first if you need to change the flag.

Storage defaults to `~/.camofox/traces/<hashed-userId>/` and is swept on server startup:

- `CAMOFOX_TRACES_DIR` - base directory (default: `~/.camofox/traces`)
- `CAMOFOX_TRACES_MAX_BYTES` - max size per trace, removed at next startup if exceeded (default: 50MB)
- `CAMOFOX_TRACES_TTL_HOURS` - traces older than this are removed at next startup (default: 24)

#### Standalone server usage

```bash
curl -X POST http://localhost:9377/sessions/agent1/cookies \
  -H 'Content-Type: application/json' \
  -H 'Authorization: Bearer YOUR_CAMOFOX_API_KEY' \
  -d '{"cookies":[{"name":"foo","value":"bar","domain":"example.com","path":"/","expires":-1,"httpOnly":false,"secure":false}]}'
```

#### Docker / Fly.io / Railway

```bash
docker run -p 9377:9377 \
  -e CAMOFOX_API_KEY="your-generated-key" \
  -v ~/.camofox/cookies:/home/node/.camofox/cookies:ro \
  camofox-browser
```

For Fly.io:
```bash
fly secrets set CAMOFOX_API_KEY="your-generated-key"
```

For Railway:
```bash
railway variables set CAMOFOX_API_KEY="your-generated-key"
```

### Proxy + GeoIP

Route all browser traffic through a proxy with automatic locale, timezone, and geolocation derived from the proxy's IP address via Camoufox's built-in GeoIP.

**Simple proxy (single endpoint):**

```bash
export PROXY_HOST=166.88.179.132
export PROXY_PORT=46040
export PROXY_USERNAME=myuser
export PROXY_PASSWORD=mypass
npm start
```

**Backconnect proxy (rotating sticky sessions):**

For providers like Decodo, Bright Data, or Oxylabs that offer a single gateway endpoint with session-based sticky IPs:

```bash
export PROXY_STRATEGY=backconnect
export PROXY_BACKCONNECT_HOST=gate.provider.com
export PROXY_BACKCONNECT_PORT=7000
export PROXY_USERNAME=myuser
export PROXY_PASSWORD=mypass
npm start
```

Each browser context gets a unique sticky session, so different users get different IP addresses. Sessions rotate automatically on proxy errors or Google blocks.

Or in Docker:

```bash
docker run -p 9377:9377 \
  -e PROXY_HOST=166.88.179.132 \
  -e PROXY_PORT=46040 \
  -e PROXY_USERNAME=myuser \
  -e PROXY_PASSWORD=mypass \
  camofox-browser
```

When a proxy is configured:
- All traffic routes through the proxy
- Camoufox's GeoIP automatically sets `locale`, `timezone`, and `geolocation` to match the proxy's exit IP
- Browser fingerprint (language, timezone, coordinates) is consistent with the proxy location
- Without a proxy, defaults to `en-US`, `America/Los_Angeles`, San Francisco coordinates

### Telemetry

Browser automation fails in ways that are hard to predict -- Cloudflare challenges, site redesigns breaking selectors, redirect loops, dialog storms, renderer crashes. The scope is wide and the failure modes are diverse. Without telemetry, the only signal is "it didn't work."

Telemetry gives us structured data on *which sites fail*, *how they fail*, and *how often*, so we can prioritize fixes for the patterns that actually affect users. It files GitHub Issues automatically when:

- **Uncaught exceptions** crash the process
- **Event loop stalls** exceed 5 seconds (watchdog detection)
- **Frustration patterns** -- 3+ consecutive failures (timeout, dead context, navigation abort) on the same tab

Each report includes the failure type, stack trace, tab health counters (HTTP status histogram, console errors, request failures, redirect depth), and the target URL -- all anonymized.

#### How it works

Telemetry is sent to a lightweight Cloudflare Worker endpoint at [`https://camofox-telemetry.askjo.workers.dev`](https://camofox-telemetry.askjo.workers.dev/health). The endpoint holds the GitHub App credentials as environment secrets -- **no secrets are shipped in this package**.

```
lib/reporter.js (client, no secrets)
    |  anonymize -> POST https://camofox-telemetry.askjo.workers.dev/report
    v
Cloudflare Worker (holds GitHub App key)
    |  validate -> rate-limit -> dedup -> create GitHub Issue
    v
GitHub Issue created
```

The endpoint source code is in this repo at [`workers/crash-reporter/index.ts`](workers/crash-reporter/index.ts).

#### Verification

You don't have to trust us -- verify what the live endpoint is running:

```bash
# 1. Ask the endpoint what code it's running
curl https://camofox-telemetry.askjo.workers.dev/source
# -> { "commit": "abc1234", "sha256": "e3b0c44...", "source": "https://github.com/..." }

# 2. Compare the sha256 against the source in this repo
sha256sum workers/crash-reporter/index.ts

# 3. Check the commit matches what CI deployed
#    https://github.com/jo-inc/camofox-browser/actions/workflows/telemetry-deploy.yml
git log --oneline workers/crash-reporter/index.ts | head -1
```

If the hashes don't match, the endpoint is running different code than what's in the repo. The deploy workflow ([`.github/workflows/telemetry-deploy.yml`](.github/workflows/telemetry-deploy.yml)) injects the commit and source hash at deploy time -- every deploy is auditable in [GitHub Actions](https://github.com/jo-inc/camofox-browser/actions/workflows/telemetry-deploy.yml).

Or skip verification entirely: `CAMOFOX_CRASH_REPORT_ENABLED=false` disables all telemetry, or point to [your own endpoint](#self-hosted-telemetry-endpoint) with `CAMOFOX_CRASH_REPORT_URL`.

#### Privacy

All reported data goes through paranoid anonymization ([`lib/reporter.js` L28-290](lib/reporter.js#L28-L290)) before leaving the process:

- **URLs** -- well-known public domains (Google, Amazon, Reddit, Cloudflare, etc.) are shown verbatim so we can identify which sites cause problems. Private/unknown domains are replaced with a stable HMAC hash (`site-a1b2c3d4`) -- same hash across reports for correlation, but not reversible to the original domain. Path segments become `*/*/*` (depth only). Query params become `?[3]` (count only). No keys, values, or path content is ever included.
- **File paths** -> stripped to filename only (`<path>/server.js`)
- **Tokens, secrets, API keys** -> `<token>`
- **IPs, emails, env vars** -> redacted
- **Docker/Fly machine IDs** -> `<id>`
- **Tab health** -- pure counters (crash count, error count, status code histogram). No page content, no URLs, no user data.

Duplicate issues are detected by stack signature and get a `+1` comment instead of a new issue.

```bash
# Disable telemetry
export CAMOFOX_CRASH_REPORT_ENABLED=false

# Point to your own endpoint (see below)
export CAMOFOX_CRASH_REPORT_URL=https://your-endpoint.example.com/report

# Adjust rate limit (default: 10 per hour)
export CAMOFOX_CRASH_REPORT_RATE_LIMIT=5
```

#### Self-hosted telemetry endpoint

To file telemetry reports in your own GitHub repo instead of `jo-inc/camofox-browser`:

1. **Create a GitHub App** -- [Settings -> Developer settings -> GitHub Apps -> New](https://github.com/settings/apps/new)
   - Permissions: **Repository -> Issues -> Read & Write**
   - Uncheck **Webhook -> Active** (not needed)
   - Click **Generate a key** -- downloads a `.pem` file
   - Install the app on your target repo (Install App -> select repo)
   - Note your **App ID** (number on the app's General page) and **Installation ID** (from the URL after installing: `github.com/settings/installations/{id}`)

2. **Deploy the endpoint** -- clone this repo and deploy the worker:
   ```bash
   cd workers/crash-reporter
   # Edit wrangler.toml: set account_id to your Cloudflare account ID
   npx wrangler deploy
   ```
   The worker is a single TypeScript file with zero npm dependencies. It also runs on Deno, Bun, or any runtime with the Web Crypto API.

3. **Set worker secrets:**
   ```bash
   cd workers/crash-reporter
   echo "YOUR_APP_ID" | npx wrangler secret put GH_APP_ID
   echo "YOUR_INSTALL_ID" | npx wrangler secret put GH_INSTALL_ID
   # Key must be PKCS#8 DER base64 (not raw PEM)
   openssl pkcs8 -topk8 -inform PEM -outform DER -nocrypt -in your-app.pem | \
     base64 | tr -d '\n' | npx wrangler secret put GH_PRIVATE_KEY
   # File issues in your repo
   echo "your-org/your-repo" | npx wrangler secret put GH_REPO
   ```

4. **Point camofox-browser to your endpoint:**
   ```bash
   export CAMOFOX_CRASH_REPORT_URL=https://your-worker.your-subdomain.workers.dev/report
   ```

5. **Verify:**
   ```bash
   curl https://your-worker.your-subdomain.workers.dev/health
   # -> {"status":"ok"}
   ```

### Structured Logging

All log output is JSON (one object per line) for easy parsing by log aggregators:

```json
{"ts":"2026-02-11T23:45:01.234Z","level":"info","msg":"req","reqId":"a1b2c3d4","method":"POST","path":"/tabs","userId":"agent1"}
{"ts":"2026-02-11T23:45:01.567Z","level":"info","msg":"res","reqId":"a1b2c3d4","status":200,"ms":333}
```

Health check requests (`/health`) are excluded from request logging to reduce noise.

### Basic Browsing

```bash
# Create a tab
curl -X POST http://localhost:9377/tabs \
  -H 'Content-Type: application/json' \
  -d '{"userId": "agent1", "sessionKey": "task1", "url": "https://example.com"}'

# Get accessibility snapshot with element refs
curl "http://localhost:9377/tabs/TAB_ID/snapshot?userId=agent1"
# -> { "snapshot": "[button e1] Submit  [link e2] Learn more", ... }

# Click by ref
curl -X POST http://localhost:9377/tabs/TAB_ID/click \
  -H 'Content-Type: application/json' \
  -d '{"userId": "agent1", "ref": "e1"}'

# Type into an element
curl -X POST http://localhost:9377/tabs/TAB_ID/type \
  -H 'Content-Type: application/json' \
  -d '{"userId": "agent1", "ref": "e2", "text": "hello", "pressEnter": true}'

# Navigate with a search macro
curl -X POST http://localhost:9377/tabs/TAB_ID/navigate \
  -H 'Content-Type: application/json' \
  -d '{"userId": "agent1", "macro": "@google_search", "query": "best coffee beans"}'
```

## API

### Tab Lifecycle

| Method | Endpoint | Description |
|--------|----------|-------------|
| `POST` | `/tabs` | Create tab with initial URL |
| `GET` | `/tabs?userId=X` | List open tabs |
| `GET` | `/tabs/:id/stats` | Tab stats (tool calls, visited URLs) |
| `DELETE` | `/tabs/:id` | Close tab |
| `DELETE` | `/tabs/group/:groupId` | Close all tabs in a group |
| `DELETE` | `/sessions/:userId` | Close all tabs for a user |

### Page Interaction

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/tabs/:id/snapshot` | Accessibility snapshot with element refs. Query params: `includeScreenshot=true` (add base64 PNG), `offset=N` (paginate large snapshots) |
| `POST` | `/tabs/:id/click` | Click element by ref or CSS selector |
| `POST` | `/tabs/:id/type` | Type text into element |
| `POST` | `/tabs/:id/press` | Press a keyboard key |
| `POST` | `/tabs/:id/scroll` | Scroll page (up/down/left/right) |
| `POST` | `/tabs/:id/navigate` | Navigate to URL or search macro |
| `POST` | `/tabs/:id/wait` | Wait for selector or timeout |
| `GET` | `/tabs/:id/links` | Extract all links on page |
| `GET` | `/tabs/:id/images` | List `<img>` elements. Query params: `includeData=true` (return inline data URLs), `maxBytes=N`, `limit=N` |
| `GET` | `/tabs/:id/downloads` | List captured downloads. Query params: `includeData=true` (base64 file data), `consume=true` (clear after read), `maxBytes=N` |
| `GET` | `/tabs/:id/screenshot` | Take screenshot |
| `POST` | `/tabs/:id/back` | Go back |
| `POST` | `/tabs/:id/forward` | Go forward |
| `POST` | `/tabs/:id/refresh` | Refresh page |

### YouTube Transcript

| Method | Endpoint | Description |
|--------|----------|-------------|
| `POST` | `/youtube/transcript` | Extract captions from a YouTube video |

```bash
curl -X POST http://localhost:9377/youtube/transcript \
  -H 'Content-Type: application/json' \
  -d '{"url": "https://www.youtube.com/watch?v=dQw4w9WgXcQ", "languages": ["en"]}'
# -> { "status": "ok", "transcript": "[00:18] [music] We're no strangers to love [music]\n...", "video_title": "...", "total_words": 548 }
```

Uses [yt-dlp](https://github.com/yt-dlp/yt-dlp) when available (fast, no browser needed). Falls back to a browser-based intercept method if yt-dlp is not installed -- this is slower and less reliable due to YouTube ad pre-rolls.

### Server

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/health` | Health check |
| `POST` | `/start` | Start browser engine |
| `POST` | `/stop` | Stop browser engine |

### Sessions

| Method | Endpoint | Description |
|--------|----------|-------------|
| `POST` | `/sessions/:userId/cookies` | Add cookies to a user session (Playwright cookie objects) |
| `GET` | `/sessions/:userId/storage_state` | Export cookies + localStorage ([VNC plugin](plugins/vnc/)) |

## Search Macros

`@google_search`  |  `@youtube_search`  |  `@amazon_search`  |  `@reddit_search`  |  `@reddit_subreddit`  |  `@wikipedia_search`  |  `@twitter_search`  |  `@yelp_search`  |  `@spotify_search`  |  `@netflix_search`  |  `@linkedin_search`  |  `@instagram_search`  |  `@tiktok_search`  |  `@twitch_search`

Reddit macros return JSON directly (no HTML parsing needed):
- `@reddit_search` - search all of Reddit, returns JSON with 25 results
- `@reddit_subreddit` - browse a subreddit (e.g., query `"programming"` -> `/r/programming.json`)

## Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `CAMOFOX_PORT` | Server port | `9377` |
| `PORT` | Server port (fallback, for platforms like Fly.io, Railway) | `9377` |
| `CAMOFOX_API_KEY` | Enable cookie import endpoint (disabled if unset) | - |
| `CAMOFOX_ADMIN_KEY` | Required for `POST /stop` | - |
| `CAMOFOX_ACCESS_KEY` | If set, all routes (except `/health`, cookie import, and `/stop`) require `Authorization: Bearer <key>`. Lets you safely expose the server beyond loopback. | - |
| `CAMOFOX_COOKIES_DIR` | Directory for cookie files | `~/.camofox/cookies` |
| `CAMOFOX_PROFILE_DIR` | Directory for persisted session profiles | `~/.camofox/profiles` |
| `CAMOFOX_TRACES_DIR` | Directory for session trace zips | `~/.camofox/traces` |
| `CAMOFOX_TRACES_MAX_BYTES` | Max size per trace, removed on next startup if exceeded | `52428800` (50MB) |
| `CAMOFOX_TRACES_TTL_HOURS` | Traces older than this are swept on startup | `24` |
| `MAX_SESSIONS` | Max concurrent browser sessions | `50` |
| `MAX_TABS_PER_SESSION` | Max tabs per session | `10` |
| `SESSION_TIMEOUT_MS` | Session inactivity timeout | `1800000` (30min) |
| `BROWSER_IDLE_TIMEOUT_MS` | Kill browser when idle (0 = never) | `300000` (5min) |
| `HANDLER_TIMEOUT_MS` | Max time for any handler | `30000` (30s) |
| `MAX_CONCURRENT_PER_USER` | Concurrent request cap per user | `3` |
| `MAX_OLD_SPACE_SIZE` | Node.js V8 heap limit (MB) | `128` |
| `PROXY_STRATEGY` | Proxy mode: `backconnect` (rotating sticky sessions) or blank (single endpoint) | - |
| `PROXY_PROVIDER` | Provider name for session format (e.g. `decodo`) | `decodo` |
| `PROXY_HOST` | Proxy hostname or IP (simple mode) | - |
| `PROXY_PORT` | Proxy port (simple mode) | - |
| `PROXY_USERNAME` | Proxy auth username | - |
| `PROXY_PASSWORD` | Proxy auth password | - |
| `PROXY_BACKCONNECT_HOST` | Backconnect gateway hostname | - |
| `PROXY_BACKCONNECT_PORT` | Backconnect gateway port | `7000` |
| `PROXY_COUNTRY` | Target country for proxy geo-targeting | - |
| `PROXY_STATE` | Target state/region for proxy geo-targeting | - |
| `TAB_INACTIVITY_MS` | Close tabs idle longer than this | `300000` (5min) |
| `CAMOFOX_CRASH_REPORT_ENABLED` | Enable anonymized crash/hang telemetry (`false` to disable) | `true` |
| `CAMOFOX_CRASH_REPORT_URL` | Telemetry endpoint ([self-hosted endpoint](#self-hosted-telemetry-endpoint)) | `https://camofox-telemetry.askjo.workers.dev/report` |
| `CAMOFOX_CRASH_REPORT_REPO` | GitHub repo for telemetry issues | `jo-inc/camofox-browser` |
| `CAMOFOX_CRASH_REPORT_RATE_LIMIT` | Max telemetry reports per hour | `10` |
| `ENABLE_VNC` | Enable VNC plugin for interactive browser access (`1`) | - |
| `VNC_PASSWORD` | Password for VNC access (recommended in production) | - |
| `NOVNC_PORT` | noVNC web UI port | `6080` |

## Architecture

```
Browser Instance (Camoufox)
\-- User Session (BrowserContext) - isolated cookies/storage
    |-- Tab Group (sessionKey: "conv1")
    |   |-- Tab (google.com)
    |   \-- Tab (github.com)
    \-- Tab Group (sessionKey: "conv2")
        \-- Tab (amazon.com)
```

Sessions auto-expire after 30 minutes of inactivity. The browser itself shuts down after 5 minutes with no active sessions, and relaunches on the next request.

When a session's tab limit is reached, the oldest/least-used tab is automatically recycled instead of returning an error -- so long-running agent sessions don't hit dead ends.

## Security Model

This section documents the security boundaries of camofox-browser for users and automated security reviewers.

### Code isolation

All `process.env` reads are centralized in `lib/config.js`. All `child_process` usage is in `lib/launcher.js` (server subprocess) and `plugins/youtube/youtube.js` (yt-dlp). The main `server.js` has route handlers but zero `process.env` reads and zero `child_process` imports. No single file combines environment/credential access with network sends.

### No embedded secrets

Zero credentials, private keys, API tokens, or signing keys ship in this package. All secrets are provided at runtime via environment variables (`CAMOFOX_API_KEY`, `CAMOFOX_ACCESS_KEY`) or are Cloudflare Worker environment secrets (telemetry endpoint GitHub App key).

### Cookie import is disabled by default

The cookie import endpoint (`POST /sessions/:userId/cookies`) is gated behind `CAMOFOX_API_KEY`. If this env var is not set, the server rejects all cookie import requests with HTTP 403. Cookie files are read from a sandboxed directory (`~/.camofox/cookies/`) with path traversal protection -- attempts to escape the directory are blocked. Max 500 cookies per request, 5MB file size limit.

### Access control

`CAMOFOX_ACCESS_KEY` provides global bearer token authentication for all routes (except `/health`). When set, every request must include `Authorization: Bearer <key>`. Recommended for any deployment beyond localhost.

### Binary download

The Camoufox browser engine (~300MB) is downloaded at `npm install` time by [`camoufox-js`](https://www.npmjs.com/package/camoufox-js), an npm package maintained by the [Camoufox project](https://camoufox.com). It downloads from [official GitHub releases](https://github.com/nicedayzhu/camoufox/releases) with integrity verification handled by `camoufox-js`. No custom download URLs, no URL shorteners, no raw IP addresses.

### Telemetry

Anonymized crash/hang telemetry is sent to a Cloudflare Worker endpoint. The endpoint source is [in this repo](workers/crash-reporter/index.ts) and auditable. Verification: `GET /source` on the endpoint returns the deployed commit hash and sha256 so you can compare against the repo. The reporter ([`lib/reporter.js` L28-290](lib/reporter.js#L28-L290)) applies paranoid anonymization: private domains are HMAC-hashed (not reversible), paths are stripped, tokens/IPs/emails are redacted. No page content, cookies, or user data is ever sent. Disable with `CAMOFOX_CRASH_REPORT_ENABLED=false` or point to your own endpoint with `CAMOFOX_CRASH_REPORT_URL`.

### Session persistence

The persistence plugin saves cookies and localStorage to `~/.camofox/profiles/<hashed-userId>/` so authenticated sessions survive browser restarts. UserIds are hashed for directory names. Disable via `camofox.config.json` by removing `persistence` from the plugins array.

### Network access

Outbound connections are made to: (1) URLs the agent navigates to (core functionality), (2) the telemetry endpoint (anonymized, opt-out available). Inbound: the REST API on localhost:9377 (default), optionally protected by `CAMOFOX_ACCESS_KEY`.

### Subprocess usage

Two subprocesses may be spawned: (1) the Camoufox browser engine (core functionality, `lib/launcher.js`), (2) yt-dlp for YouTube transcript extraction (optional, `plugins/youtube/youtube.js`). Both are isolated in dedicated files separate from route handlers.

## Testing

```bash
npm test              # all tests
npm run test:e2e      # e2e tests only
npm run test:live     # live site tests (Google, macros)
npm run test:debug    # with server output
```

## npm

```bash
npm install @askjo/camofox-browser
```

## Credits

- [Camoufox](https://camoufox.com) - Firefox-based browser with C++ anti-detection
- [Donate to Camoufox's original creator daijro](https://camoufox.com/about/)
- [OpenClaw](https://openclaw.ai) - Open-source AI agent framework

## Crypto Scam Warning

Sketchy people are doing sketchy things with crypto tokens named "Camofox" now that this project is getting attention. **Camofox is not a crypto project and will never be one.** Any token, coin, or NFT using the Camofox name has nothing to do with us.

## License

MIT
