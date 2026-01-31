---
name: jo-camoufox-browser
description: Control a headless Camoufox browser with anti-detection. Browse websites, search Google/YouTube/Amazon, click elements, fill forms, and extract content.
globs:
requirements:
  bins:
    - node
    - npm
  install: npm install && npm start
---

# jo-camoufox-browser Skill

You can control a headless Camoufox browser running at `http://localhost:3000`. Camoufox is a Firefox-based browser with C++ anti-detection that bypasses bot detection including Google captcha.

## Installation

If the server is not running, start it:

```bash
cd {baseDir}
npm install
npm start
```

The server runs on port 3000. Check health with: `curl http://localhost:3000/health`

## How to Use

### 1. Create a Tab

```bash
curl -X POST http://localhost:3000/tabs \
  -H "Content-Type: application/json" \
  -d '{"userId": "clawdbot", "listItemId": "task1", "url": "https://example.com"}'
```

Save the `tabId` from the response for subsequent requests.

### 2. Get Page Content

```bash
curl "http://localhost:3000/tabs/TAB_ID/snapshot?userId=clawdbot"
```

This returns an accessibility snapshot with element refs like `e1`, `e2`, `e3`. These refs are stable identifiers you use to click or type into elements.

### 3. Click Elements

Use the ref from the snapshot:

```bash
curl -X POST http://localhost:3000/tabs/TAB_ID/click \
  -H "Content-Type: application/json" \
  -d '{"userId": "clawdbot", "ref": "e1"}'
```

### 4. Type Text

```bash
curl -X POST http://localhost:3000/tabs/TAB_ID/type \
  -H "Content-Type: application/json" \
  -d '{"userId": "clawdbot", "ref": "e2", "text": "hello world", "pressEnter": true}'
```

### 5. Search with Macros

Instead of navigating to search URLs, use macros:

```bash
curl -X POST http://localhost:3000/tabs/TAB_ID/navigate \
  -H "Content-Type: application/json" \
  -d '{"userId": "clawdbot", "macro": "@google_search", "query": "weather in New York"}'
```

Available macros:
- `@google_search` - Search Google
- `@youtube_search` - Search YouTube
- `@amazon_search` - Search Amazon
- `@reddit_search` - Search Reddit
- `@wikipedia_search` - Search Wikipedia
- `@twitter_search` - Search Twitter/X

### 6. Scroll the Page

```bash
curl -X POST http://localhost:3000/tabs/TAB_ID/scroll \
  -H "Content-Type: application/json" \
  -d '{"userId": "clawdbot", "direction": "down", "amount": 500}'
```

### 7. Navigate Back/Forward

```bash
curl -X POST http://localhost:3000/tabs/TAB_ID/back \
  -H "Content-Type: application/json" \
  -d '{"userId": "clawdbot"}'
```

### 8. Get All Links

```bash
curl "http://localhost:3000/tabs/TAB_ID/links?userId=clawdbot&limit=50"
```

### 9. Close Tab When Done

```bash
curl -X DELETE "http://localhost:3000/tabs/TAB_ID?userId=clawdbot"
```

## Workflow Pattern

1. Create tab with initial URL
2. Get snapshot to see page content and element refs
3. Click/type using refs from snapshot
4. Get new snapshot after each navigation (refs reset)
5. Repeat until task complete
6. Close tab

## Tips

- Always get a fresh snapshot after clicking links or submitting forms
- Use `pressEnter: true` when typing in search boxes
- Element refs (`e1`, `e2`) reset after navigation - always get new snapshot
- Use macros for searching instead of constructing URLs manually
- The browser has anti-detection so it works with Google, Amazon, etc.

## All Endpoints

| Method | Path | Description |
|--------|------|-------------|
| POST | `/tabs` | Create tab |
| GET | `/tabs/:id/snapshot` | Get page content with refs |
| POST | `/tabs/:id/navigate` | Go to URL or macro |
| POST | `/tabs/:id/click` | Click element |
| POST | `/tabs/:id/type` | Type text |
| POST | `/tabs/:id/scroll` | Scroll page |
| POST | `/tabs/:id/back` | Go back |
| POST | `/tabs/:id/forward` | Go forward |
| GET | `/tabs/:id/links` | Get all links |
| DELETE | `/tabs/:id` | Close tab |
