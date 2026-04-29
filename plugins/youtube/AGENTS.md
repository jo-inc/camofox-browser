# YouTube Plugin — Agent Guide

Extracts video transcripts via yt-dlp (preferred) with Playwright browser fallback.

## Endpoint

`POST /youtube/transcript` — unauthenticated by default (set `"auth": true` in plugin config to require auth).

## Key Files

- `index.js` — route handler + browser fallback logic
- `youtube.js` — yt-dlp process management + transcript parsing (`child_process` isolated here)
- `youtube.test.js` — parser unit tests
- `apt.txt` — system deps (python3-minimal for yt-dlp)
- `post-install.sh` — downloads yt-dlp binary

## Code Separation

`child_process` is in `youtube.js`, route handlers are in `index.js` — separate files per project conventions.

## Maintainers

- [@pradeepe](https://github.com/pradeepe) — extracted from core into plugin system

For PRs touching this plugin, tag the maintainers above for review.
