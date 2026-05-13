# Camofox Browser

Anti-detection browser automation via Camoufox (Firefox fork with C++ fingerprint spoofing).

## When to use

Use this skill to browse the real web without getting blocked — Cloudflare, Google, bot detection all bypassed at the C++ level. The server must already be running (`npm start` in camofox-browser repo or `make up` for Docker). Check server status with `camofox health` first.

## Key concepts

- **Tabs** hold a single page each. Create with `camofox create <url>`, get a `tabId` back.
- **Snapshots** return accessibility-tree text (NOT raw HTML), ~90% smaller for LLM consumption. Elements get stable refs like `[e1]`, `[e2]`.
- **Refs** (`e1`, `e2`, ...) are how you interact — use them with `click`, `type`, `extract`.
- **Search macros** like `@google_search`, `@youtube_search`, `@reddit_search` auto-navigate to results.
- **Sessions** isolate cookies/storage per `CAMOFOX_USER` (default: `claude`).

## CLI reference

All commands use the env vars:
- `CAMOFOX_URL` — server base URL (default: `http://localhost:9377`)
- `CAMOFOX_USER` — user ID for session isolation (default: `claude`)
- `CAMOFOX_ACCESS_KEY` — optional bearer token for server auth

### Core operations
| Command | Description |
|---------|-------------|
| `camofox health` | Check server and browser status |
| `camofox create <url> [--session <key>] [--trace]` | Open a new tab, returns `tabId` |
| `camofox snapshot <tab-id> [--screenshot]` | Get accessibility snapshot with refs |
| `camofox click <tab-id> <ref\|selector>` | Click element by ref (e1) or CSS selector |
| `camofox type <tab-id> <ref> "<text>" [--enter]` | Type into an input element |
| `camofox navigate <tab-id> <url\|@macro>` | Navigate tab to URL or search macro |
| `camofox navigate <tab-id> @google_search` | Special: navigate with empty query triggers search macro. For actual search, use the full URL |
| `camofox scroll <tab-id> [up\|down\|left\|right]` | Scroll page (default: down) |
| `camofox screenshot <tab-id>` | Capture screenshot as base64 PNG |
| `camofox close <tab-id>` | Close a tab |
| `camofox list` | List all open tabs for current user |
| `camofox session close` | Close all tabs for current user |

### Extended operations
| Command | Description |
|---------|-------------|
| `camofox links <tab-id>` | Extract all links on page |
| `camofox images <tab-id> [data]` | List `<img>` elements (add `data` for inline base64) |
| `camofox wait <tab-id> <css-selector>` | Wait for element to appear |
| `camofox press <tab-id> <key>` | Press a keyboard key (Enter, Tab, Escape, etc.) |
| `camofox back <tab-id>` | Navigate back in history |
| `camofox forward <tab-id>` | Navigate forward |
| `camofox refresh <tab-id>` | Refresh current page |
| `camofox extract <tab-id> '<json-schema>'` | Structured data extraction |
| `camofox cookies import <file> [domain]` | Import Netscape cookie file (requires `CAMOFOX_API_KEY`) |

## Search macros

`@google_search`, `@youtube_search`, `@amazon_search`, `@reddit_search`, `@reddit_subreddit`, `@wikipedia_search`, `@twitter_search`, `@yelp_search`, `@spotify_search`, `@netflix_search`, `@linkedin_search`, `@instagram_search`, `@tiktok_search`, `@twitch_search`

For search macros, set the url to the macro and add a query parameter. Example: to search Google for "best coffee", use `camofox navigate <tab-id> "https://www.google.com/search?q=best+coffee"` directly instead — the macros are primarily for agent frameworks. For direct API use, navigate to the search URL directly.

## Typical workflow

```bash
# 1. Check server is alive
camofox health

# 2. Open a page
camofox create https://news.ycombinator.com
# → {"tabId": "abc-123", ...}

# 3. Read the page
camofox snapshot abc-123
# → heading "Hacker News" [e1] link "Article title" ...

# 4. Click something
camofox click abc-123 e1

# 5. Check the result
camofox snapshot abc-123

# 6. Done
camofox close abc-123
```

## Anti-detection

Camofox is Firefox-based with C++ patches. These are spoofed BEFORE JavaScript runs:
- `navigator.hardwareConcurrency`, WebGL renderer, AudioContext
- Screen geometry, WebRTC
- `navigator.webdriver` naturally absent (unlike Chrome stealth plugins)