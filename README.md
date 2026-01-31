# jo-camoufox-browser

A headless browser automation server designed for AI agents. Powered by [Camoufox](https://camoufox.com) - a Firefox-based browser with C++ anti-detection that bypasses bot detection including Google captcha.

**Perfect for:** Clawdbot/Moltbot, Claude Code, LangChain agents, AutoGPT, and any AI system that needs to browse the web.

## Features

- **Anti-Detection** - Camoufox engine (Firefox-based) with C++ fingerprint spoofing, bypasses Google captcha
- **Element Refs** - Stable `e1`, `e2`, `e3` references for clicking/typing (like Clawdbot's browser)
- **Session Isolation** - Separate cookies/storage per user, tabs grouped by conversation
- **Search Macros** - `@google_search`, `@youtube_search`, `@amazon_search` and more
- **Token-Efficient** - Accessibility snapshots instead of full HTML (90% smaller)
- **Docker Ready** - Production Dockerfile with pre-baked Camoufox binary

## Quick Start

```bash
# Clone and install
git clone https://github.com/jo-inc/jo-camoufox-browser
cd jo-camoufox-browser
npm install

# Start server (downloads Camoufox browser on first run)
npm start

# Server runs on http://localhost:3000
```

## API Overview

### Create a Tab
```bash
curl -X POST http://localhost:3000/tabs \
  -H "Content-Type: application/json" \
  -d '{"userId": "user1", "listItemId": "conv1", "url": "https://example.com"}'
```

### Get Page Snapshot (with element refs)
```bash
curl "http://localhost:3000/tabs/TAB_ID/snapshot?userId=user1"
```

Response includes refs for interaction:
```json
{
  "snapshot": "[button e1] Submit  [link e2] Learn more",
  "refs": {
    "e1": { "role": "button", "name": "Submit" },
    "e2": { "role": "link", "name": "Learn more" }
  },
  "url": "https://example.com"
}
```

### Click an Element
```bash
curl -X POST http://localhost:3000/tabs/TAB_ID/click \
  -H "Content-Type: application/json" \
  -d '{"userId": "user1", "ref": "e1"}'
```

### Search with Macros
```bash
curl -X POST http://localhost:3000/tabs/TAB_ID/navigate \
  -H "Content-Type: application/json" \
  -d '{"userId": "user1", "macro": "@google_search", "query": "best coffee beans"}'
```

## All Endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | `/health` | Health check |
| GET | `/tabs?userId=X` | List all tab groups for user |
| POST | `/tabs` | Create new tab |
| DELETE | `/tabs/:tabId` | Close tab |
| POST | `/tabs/:tabId/navigate` | Navigate to URL or macro |
| GET | `/tabs/:tabId/snapshot` | Get accessibility snapshot with refs |
| POST | `/tabs/:tabId/click` | Click element by ref or selector |
| POST | `/tabs/:tabId/type` | Type into element |
| POST | `/tabs/:tabId/scroll` | Scroll page |
| POST | `/tabs/:tabId/back` | Go back |
| POST | `/tabs/:tabId/forward` | Go forward |
| POST | `/tabs/:tabId/refresh` | Refresh page |
| GET | `/tabs/:tabId/links` | Get all links |
| GET | `/tabs/:tabId/screenshot` | Get screenshot |
| DELETE | `/sessions/:userId` | Close all tabs for user |

## Search Macros

Navigate supports these macros for common sites:

- `@google_search` - Google
- `@youtube_search` - YouTube
- `@amazon_search` - Amazon
- `@reddit_search` - Reddit
- `@wikipedia_search` - Wikipedia
- `@twitter_search` - Twitter/X
- `@yelp_search` - Yelp
- `@spotify_search` - Spotify
- `@netflix_search` - Netflix
- `@linkedin_search` - LinkedIn
- `@instagram_search` - Instagram
- `@tiktok_search` - TikTok
- `@twitch_search` - Twitch

## Architecture

```
Browser Instance
└── User Session (BrowserContext) - isolated cookies/storage
    ├── Tab Group (listItemId: "conv1") - conversation A
    │   ├── Tab (google.com)
    │   └── Tab (github.com)
    └── Tab Group (listItemId: "conv2") - conversation B
        └── Tab (amazon.com)
```

- One browser instance shared across users
- Separate BrowserContext per user (isolated cookies/storage)
- Tabs grouped by `listItemId` (conversation/task)
- 30-minute session timeout with automatic cleanup

## Browser Engines

Two engines available:

| Engine | File | Description |
|--------|------|-------------|
| **Camoufox** (default) | `server-camoufox.js` | Firefox-based, C++ anti-detection, bypasses Google captcha |
| Chrome (legacy) | `server.js` | Playwright + stealth plugin, blocked by Google |

## Running Locally

### Camoufox (recommended)
```bash
./run-camoufox.sh
# Or: npm start
```
First run downloads the Camoufox browser (~300MB).

### Chrome (legacy)
```bash
./run.sh
# Or: npm run start:chrome
```

## Docker Deployment

```bash
# Build with Camoufox (recommended)
docker build -f Dockerfile.camoufox -t jo-camoufox-browser .

# Run
docker run -p 3000:3000 jo-camoufox-browser
```

## Fly.io Deployment

```bash
fly launch --no-deploy
fly deploy
```

## Testing

```bash
npm test                 # Run all e2e tests
npm run test:live        # Run live Google tests (may hit captcha)
npm run test:debug       # Show server output for debugging
```

## Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `PORT` | Server port | 3000 |
| `NODE_ENV` | Environment | development |
| `CHROMIUM_PATH` | Custom Chromium path | - |

## License

MIT
