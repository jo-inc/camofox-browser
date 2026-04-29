# VNC Plugin — Agent Guide

Interactive browser access via noVNC. Log into sites visually, solve CAPTCHAs, approve OAuth prompts — then export the authenticated storage state for agent reuse.

## Endpoints

- `GET /vnc/status` — check if VNC is running (no auth)
- `GET /sessions/:userId/storage_state` — export cookies + localStorage as JSON (requires auth)

## Activation

Disabled by default. Enable with `ENABLE_VNC=1` env var or `"vnc": { "enabled": true }` in `camofox.config.json`.

## Key Files

- `index.js` — route handlers only (no `child_process`, no `process.env` reads)
- `vnc-launcher.js` — process management, config resolution from env vars (`child_process` isolated here)
- `vnc-watcher.sh` — shell script that detects Xvfb, attaches x11vnc, starts noVNC
- `vnc.test.js` — unit tests
- `apt.txt` — system deps (x11vnc, novnc, websockify, etc.)

## Code Separation

`child_process` is in `vnc-launcher.js`, route handlers are in `index.js`, env var reads are in `vnc-launcher.js` — separate files per project conventions.

## Security

- noVNC binds to `127.0.0.1` by default — set `VNC_BIND=0.0.0.0` to expose externally
- Set `VNC_PASSWORD` for password-protected access
- `VIEW_ONLY=1` disables keyboard/mouse input (observation only)
- Storage state export endpoint requires auth (API key or loopback)

## Architecture

The plugin overrides `ctx.createVirtualDisplay` to use a higher-resolution display (default 1920x1080 instead of 1x1). `vnc-watcher.sh` polls for the Xvfb process, then attaches x11vnc + noVNC on top.

## Original Contributors

- [@leoneparise](https://github.com/leoneparise) — original VNC implementation + keyboard mode ([PR #65](https://github.com/jo-inc/camofox-browser/pull/65), [PR #66](https://github.com/jo-inc/camofox-browser/pull/66))
- [@pradeepe](https://github.com/pradeepe) — plugin system integration, code separation refactor, security hardening

For PRs touching this plugin, tag the contributors above for review.
