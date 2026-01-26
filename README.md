# jo-browser

Headless Chrome service for Jo, running on Fly.io private network.

## Architecture

- One browser instance shared across all users
- Separate BrowserContext per user (isolated cookies/storage)
- Tabs grouped by listItemId (conversation/task)
- 30-minute session timeout
- Accessibility snapshots for token-efficient AI interaction

```
Browser
└── User Session (BrowserContext) - isolated cookies/storage
    ├── Tab Group (listItemId: 123) - conversation A
    │   ├── Tab (google.com)
    │   └── Tab (github.com)
    └── Tab Group (listItemId: 456) - conversation B
        └── Tab (amazon.com)
```

## Endpoints

All endpoints use `userId` to identify the user session.

### Tab Management
| Method | Path | Description |
|--------|------|-------------|
| GET | `/health` | Health check |
| GET | `/tabs?userId=X` | List all tab groups for user |
| GET | `/tabs/group/:listItemId?userId=X` | List tabs in a group |
| POST | `/tabs` | Create new tab (requires listItemId) |
| DELETE | `/tabs/:tabId` | Close tab |
| DELETE | `/tabs/group/:listItemId` | Close all tabs for conversation |
| DELETE | `/sessions/:userId` | Close all tabs for user |

### Navigation & Content
| Method | Path | Description |
|--------|------|-------------|
| POST | `/tabs/:tabId/navigate` | Navigate to URL or macro |
| POST | `/tabs/:tabId/back` | Go back in history |
| POST | `/tabs/:tabId/forward` | Go forward in history |
| POST | `/tabs/:tabId/refresh` | Refresh page |
| GET | `/tabs/:tabId/snapshot?userId=X&format=text` | Get accessibility snapshot with refs |
| GET | `/tabs/:tabId/links?userId=X&limit=50&offset=0` | Get all links from page |
| GET | `/tabs/:tabId/screenshot?userId=X&fullPage=true` | Get screenshot |
| GET | `/tabs/:tabId/stats?userId=X` | Get tab stats (visited URLs, tool calls) |

### Interactions (use `ref` from snapshot or CSS `selector`)
| Method | Path | Description |
|--------|------|-------------|
| POST | `/tabs/:tabId/click` | Click element by ref or selector |
| POST | `/tabs/:tabId/type` | Type into element by ref or selector |
| POST | `/tabs/:tabId/press` | Press key |
| POST | `/tabs/:tabId/scroll` | Scroll page (direction: up/down, amount: pixels) |

## URL Macros

Navigate supports macros for common search sites:

```json
POST /tabs/:tabId/navigate
{ "userId": "123", "macro": "@google_search", "query": "best coffee beans" }
```

Supported macros:
- `@google_search`, `@youtube_search`, `@amazon_search`
- `@reddit_search`, `@wikipedia_search`, `@twitter_search`
- `@yelp_search`, `@spotify_search`, `@netflix_search`
- `@linkedin_search`, `@instagram_search`, `@tiktok_search`, `@twitch_search`

## Element Refs

Like Clawdbot, we use element refs (`e1`, `e2`, etc.) for stable element references:

1. Call `/snapshot` to get the page structure with refs
2. Use refs in subsequent `/click` or `/type` calls
3. Refs are rebuilt on each snapshot (cleared on navigation)

```json
// Snapshot response
{
  "snapshot": "...",
  "refs": {
    "e1": { "role": "button", "name": "Submit" },
    "e2": { "role": "link", "name": "Learn more" }
  },
  "url": "https://example.com"
}

// Click using ref
POST /tabs/:tabId/click
{ "userId": "123", "ref": "e1" }
```

## Deploy

```bash
fly launch --no-deploy
fly deploy
```

## Local dev

```bash
npm install
# Requires Chromium installed locally
CHROMIUM_PATH=/usr/bin/chromium node server.js
```

## Connect from Jo

From jo-bot on Fly private network:

```python
BROWSER_URL = "http://jo-browser.internal:3000"
```
