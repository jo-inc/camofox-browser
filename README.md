<div align="center">
  <img src="fox.png" alt="camofox-browser" width="200" />
  <h1>camofox-browser</h1>
  <p><strong>Anti-detection browser server for AI agents, powered by Camoufox</strong></p>
  <p>
    <a href="https://github.com/jo-inc/camofox-browser/actions"><img src="https://img.shields.io/badge/build-passing-brightgreen" alt="Build" /></a>
    <a href="https://opensource.org/licenses/MIT"><img src="https://img.shields.io/badge/license-MIT-blue" alt="License" /></a>
    <a href="https://camoufox.com"><img src="https://img.shields.io/badge/engine-Camoufox-red" alt="Camoufox" /></a>
    <a href="https://hub.docker.com"><img src="https://img.shields.io/badge/docker-ready-blue" alt="Docker" /></a>
  </p>
  <p>
    Standing on the mighty shoulders of <a href="https://camoufox.com">Camoufox</a> - a Firefox fork with fingerprint spoofing at the C++ level.
    <br/><br/>
    The same engine behind <a href="https://askjo.ai">askjo.ai</a>'s web browsing.
  </p>
</div>

<br/>

---

## Why

AI agents need to browse the real web. Playwright gets blocked. Headless Chrome gets fingerprinted. Stealth plugins become the fingerprint.

Camoufox patches Firefox at the **C++ implementation level** - `navigator.hardwareConcurrency`, WebGL renderers, AudioContext, screen geometry, WebRTC - all spoofed before JavaScript ever sees them. No shims, no wrappers, no tells.

This project wraps that engine in a REST API built for agents: accessibility snapshots instead of bloated HTML, stable element refs for clicking, and search macros for common sites.

## Features

- **C++ Anti-Detection** - bypasses Google, Cloudflare, and most bot detection
- **Element Refs** - stable `e1`, `e2`, `e3` identifiers for reliable interaction
- **Token-Efficient** - accessibility snapshots are ~90% smaller than raw HTML
- **Session Isolation** - separate cookies/storage per user
- **Cookie Import** - inject Netscape-format cookie files for authenticated browsing
- **Proxy + GeoIP** - route traffic through residential proxies with automatic locale/timezone
- **Structured Logging** - JSON log lines with request IDs for production observability
- **Search Macros** - `@google_search`, `@youtube_search`, `@amazon_search`, `@reddit_subreddit`, and 10 more
- **Deploy Anywhere** - Docker, Fly.io, Railway

## Quick Start

### OpenClaw Plugin

```bash
openclaw plugins install @askjo/camofox-browser
```

**Tools:** `camofox_create_tab` · `camofox_snapshot` · `camofox_click` · `camofox_type` · `camofox_navigate` · `camofox_scroll` · `camofox_screenshot` · `camofox_close_tab` · `camofox_list_tabs` · `camofox_import_cookies`

### Standalone

```bash
git clone https://github.com/jo-inc/camofox-browser
cd camofox-browser
npm install
npm start  # downloads Camoufox on first run (~300MB)
```

Default port is `9377`. See [Environment Variables](#environment-variables) for all options.

### Docker

```bash
docker build -t camofox-browser .
docker run -p 9377:9377 camofox-browser
```

### Fly.io / Railway

`fly.toml` and `railway.toml` are included. Deploy with `fly deploy` or connect the repo to Railway.

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

The same key is used by both the plugin (to authenticate requests) and the server (to verify them). Both run from the same environment — set it once.

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

The agent calls `camofox_import_cookies` → reads the file → POSTs to the server with the Bearer token → cookies are injected into the browser session. Subsequent `camofox_create_tab` calls to linkedin.com will be authenticated.

#### How it works

```
~/.camofox/cookies/linkedin.txt          (Netscape format, on disk)
        │
        ▼
camofox_import_cookies tool              (parses file, filters by domain)
        │
        ▼  POST /sessions/:userId/cookies
        │  Authorization: Bearer <CAMOFOX_API_KEY>
        │  Body: { cookies: [Playwright cookie objects] }
        ▼
camofox server                           (validates, sanitizes, injects)
        │
        ▼  context.addCookies(...)
        │
Camoufox browser session                 (authenticated browsing)
```

- `cookiesPath` is resolved relative to the cookies directory — path traversal outside it is blocked
- Max 500 cookies per request, 5MB file size limit
- Cookie objects are sanitized to an allowlist of Playwright fields

#### Standalone server usage

```bash
curl -X POST http://localhost:9377/sessions/agent1/cookies \
  -H 'Content-Type: application/json' \
  -H 'Authorization: Bearer YOUR_CAMOFOX_API_KEY' \
  -d '{"cookies":[{"name":"foo","value":"bar","domain":"example.com","path":"/","expires":-1,"httpOnly":false,"secure":false}]}'
```

#### Docker / Fly.io

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

### Proxy + GeoIP

Route all browser traffic through a proxy with automatic locale, timezone, and geolocation derived from the proxy's IP address via Camoufox's built-in GeoIP.

Set these environment variables before starting the server:

```bash
export PROXY_HOST=166.88.179.132
export PROXY_PORT=46040
export PROXY_USERNAME=myuser
export PROXY_PASSWORD=mypass
npm start
```

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
# → { "snapshot": "[button e1] Submit  [link e2] Learn more", ... }

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
| `GET` | `/tabs/:id/snapshot` | Accessibility snapshot with element refs |
| `POST` | `/tabs/:id/click` | Click element by ref or CSS selector |
| `POST` | `/tabs/:id/type` | Type text into element |
| `POST` | `/tabs/:id/press` | Press a keyboard key |
| `POST` | `/tabs/:id/scroll` | Scroll page (up/down/left/right) |
| `POST` | `/tabs/:id/navigate` | Navigate to URL or search macro |
| `POST` | `/tabs/:id/wait` | Wait for selector or timeout |
| `GET` | `/tabs/:id/links` | Extract all links on page |
| `GET` | `/tabs/:id/screenshot` | Take screenshot |
| `POST` | `/tabs/:id/back` | Go back |
| `POST` | `/tabs/:id/forward` | Go forward |
| `POST` | `/tabs/:id/refresh` | Refresh page |

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

## Search Macros

`@google_search` · `@youtube_search` · `@amazon_search` · `@reddit_search` · `@reddit_subreddit` · `@wikipedia_search` · `@twitter_search` · `@yelp_search` · `@spotify_search` · `@netflix_search` · `@linkedin_search` · `@instagram_search` · `@tiktok_search` · `@twitch_search`

Reddit macros return JSON directly (no HTML parsing needed):
- `@reddit_search` - search all of Reddit, returns JSON with 25 results
- `@reddit_subreddit` - browse a subreddit (e.g., query `"programming"` → `/r/programming.json`)

## Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `CAMOFOX_PORT` | Server port | `9377` |
| `CAMOFOX_API_KEY` | Enable cookie import endpoint (disabled if unset) | - |
| `CAMOFOX_ADMIN_KEY` | Required for `POST /stop` | - |
| `CAMOFOX_COOKIES_DIR` | Directory for cookie files | `~/.camofox/cookies` |
| `PROXY_HOST` | Proxy hostname or IP | - |
| `PROXY_PORT` | Proxy port | - |
| `PROXY_USERNAME` | Proxy auth username | - |
| `PROXY_PASSWORD` | Proxy auth password | - |

## Architecture

```
Browser Instance (Camoufox)
└── User Session (BrowserContext) - isolated cookies/storage
    ├── Tab Group (sessionKey: "conv1")
    │   ├── Tab (google.com)
    │   └── Tab (github.com)
    └── Tab Group (sessionKey: "conv2")
        └── Tab (amazon.com)
```

Sessions auto-expire after 30 minutes of inactivity.

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
