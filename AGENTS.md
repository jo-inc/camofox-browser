# jo-browser Agent Guide

Headless browser service for Jo AI, running on Fly.io or locally.

## Engines

Three browser engines available:
- **Camoufox** (server-camoufox.js) - Firefox-based, C++ level anti-detection, bypasses Google captcha **(DEFAULT)**
- **Chrome** (server.js) - Playwright + stealth plugin, blocked by Google (legacy)
- **Local Safari** (jo_bot/local_safari_browser_engine.py) - Uses macOS Swift WebView via WebSocket

## Engine Selection

The Python client (`chrome_browser_agent.py`) automatically selects the engine:
- **macOS with WebSocket conn**: Uses LocalSafariBrowserEngine (has auth tokens, cookies)
- **Server/no conn**: Uses remote jo-browser service (Chrome or Camoufox)

## Running Locally

### Camoufox engine (default)
```bash
./run-camoufox.sh
```
- First run fetches the Camoufox browser binary (~300MB)
- Logs: `/tmp/jo-browser-camoufox.log`

### Chrome engine (legacy)
```bash
./run.sh
```
- Logs: `/tmp/jo-browser.log`

Both serve on http://localhost:3000 with identical APIs.

## Testing

### Jest Test Suite (Recommended)
```bash
# Install dependencies
npm install

# Run all tests (e2e only, skips live Google tests)
npm test

# Run specific test suites
npm run test:e2e          # Local deterministic tests only
npm run test:live         # Live Google tests (may hit captcha)
npm run test:debug        # Show server stdout for debugging
```

Test structure:
- `tests/e2e/` - Deterministic tests using local test site
  - `tabLifecycle.test.js` - Create, close tabs, sessions
  - `navigation.test.js` - Navigate, back, forward, refresh
  - `snapshotLinks.test.js` - Get page content, extract links
  - `typingEnter.test.js` - Type text, press Enter
  - `formSubmission.test.js` - Fill forms, click buttons
  - `scroll.test.js` - Scroll page
- `tests/live/` - Live web tests (opt-in via RUN_LIVE_TESTS=1)
  - `googleSearch.test.js` - @google_search macro, click results

### Python Client Test (Legacy)
```bash
cd ../jo_bot
JO_BROWSER_URL=http://localhost:3000 python evals/features/browser/client_test.py
```

## Deployment

```bash
fly deploy
```

## Camoufox Version

The Dockerfile.camoufox pre-bakes a pinned version of Camoufox for reproducible builds:
- **Current**: v135.0.1-beta.24 (Linux x86_64)
- **Image size**: ~1.85GB
- **Source**: https://github.com/daijro/camoufox/releases

To upgrade Camoufox, update the `ARG` values at the top of Dockerfile.camoufox:
```dockerfile
ARG CAMOUFOX_VERSION=135.0.1
ARG CAMOUFOX_RELEASE=beta.24
```

## Key Files

- `server-camoufox.js` - Camoufox engine (Firefox-based anti-detect) **(DEFAULT)**
- `server.js` - Chrome engine (Playwright + stealth plugin) (legacy)
- `Dockerfile.camoufox` - Production container with Camoufox
- `Dockerfile` - Legacy Chrome container
- `fly.toml` - Fly.io deployment config
- `../jo_bot/bot/jo/models/agents/local_safari_browser_engine.py` - Local Safari engine
- `../jo_bot/bot/jo/models/agents/chrome_browser_agent.py` - Python client with engine routing

## Tabs API

All engines implement the same REST-like tabs API:
- `POST /tabs` - Create new tab (`userId`, `listItemId`, `url?`)
- `POST /tabs/:tabId/navigate` - Navigate to URL or macro
- `GET /tabs/:tabId/snapshot` - Get page content with element refs
- `POST /tabs/:tabId/click` - Click element by ref or selector
- `POST /tabs/:tabId/type` - Type text into element
- `POST /tabs/:tabId/scroll` - Scroll page
- `POST /tabs/:tabId/back` - Navigate back
- `POST /tabs/:tabId/forward` - Navigate forward
- `POST /tabs/:tabId/refresh` - Refresh page
- `GET /tabs/:tabId/links` - Get all links
- `DELETE /tabs/:tabId` - Close tab
