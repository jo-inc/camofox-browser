# jo-browser Agent Guide

Headless Chrome browser service for Jo AI, running on Fly.io or locally.

## Running Locally

```bash
./run.sh
```

- Auto-reloads on server.js changes (nodemon)
- Logs: `/tmp/jo-browser.log`
- URL: http://localhost:3000

## Testing

```bash
# Run client test from jo_bot
cd ../jo_bot
JO_BROWSER_URL=http://localhost:3000 python evals/features/browser/client_test.py
```

## Deployment

```bash
fly deploy
```

## Key Files

- `server.js` - Express server with Playwright browser automation
- `Dockerfile` - Production container with Chromium
- `fly.toml` - Fly.io deployment config
