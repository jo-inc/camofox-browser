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
    Standing on the mighty shoulders of <a href="https://camoufox.com">Camoufox</a> — a Firefox fork with fingerprint spoofing at the C++ level.
    <br/><br/>
    The same engine behind <a href="https://askjo.ai">askjo.ai</a>'s web browsing.
  </p>
</div>

<br/>

---

## Why

AI agents need to browse the real web. Playwright gets blocked. Headless Chrome gets fingerprinted. Stealth plugins become the fingerprint.

Camoufox patches Firefox at the **C++ implementation level** — `navigator.hardwareConcurrency`, WebGL renderers, AudioContext, screen geometry, WebRTC — all spoofed before JavaScript ever sees them. No shims, no wrappers, no tells.

This project wraps that engine in a REST API built for agents: accessibility snapshots instead of bloated HTML, stable element refs for clicking, and search macros for common sites.

## Features

- **C++ Anti-Detection** — bypasses Google, Cloudflare, and most bot detection
- **Element Refs** — stable `e1`, `e2`, `e3` identifiers for reliable interaction
- **Token-Efficient** — accessibility snapshots are ~90% smaller than raw HTML
- **Session Isolation** — separate cookies/storage per user
- **Search Macros** — `@google_search`, `@youtube_search`, `@amazon_search`, and 10 more
- **Deploy Anywhere** — Docker, Fly.io, Railway

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

Default port is `9377`. Set `CAMOFOX_PORT` to override.

### Docker

```bash
docker build -t camofox-browser .
docker run -p 9377:9377 camofox-browser
```

### Fly.io / Railway

`fly.toml` and `railway.toml` are included. Deploy with `fly deploy` or connect the repo to Railway.

## Usage

### Cookie Injection (Netscape cookie file → Playwright cookies)

If you’re using the OpenClaw plugin, you can import a Netscape-format cookie file (e.g., exported from a browser) to authenticate sessions without interactive login.

- Tool: `camofox_import_cookies`
- Server endpoint: `POST /sessions/:userId/cookies`

```bash
# OpenClaw tool usage (conceptual)
# camofox_import_cookies({ cookiesPath: "/path/to/cookies.txt", domainSuffix: "linkedin.com" })

# Direct server usage (Playwright cookie objects)
curl -X POST http://localhost:9377/sessions/agent1/cookies \
  -H 'Content-Type: application/json' \
  -d '{"cookies":[{"name":"foo","value":"bar","domain":"example.com","path":"/","expires":-1,"httpOnly":false,"secure":false}]}'
```

## Usage

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

`@google_search` · `@youtube_search` · `@amazon_search` · `@reddit_search` · `@wikipedia_search` · `@twitter_search` · `@yelp_search` · `@spotify_search` · `@netflix_search` · `@linkedin_search` · `@instagram_search` · `@tiktok_search` · `@twitch_search`

## Architecture

```
Browser Instance (Camoufox)
└── User Session (BrowserContext) — isolated cookies/storage
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

- [Camoufox](https://camoufox.com) — Firefox-based browser with C++ anti-detection
- [OpenClaw](https://openclaw.ai) — Open-source AI agent framework

## License

MIT
