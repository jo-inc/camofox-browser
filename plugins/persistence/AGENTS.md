# Persistence Plugin — Agent Guide

Persists browser state across logical session expiry and browser-process restarts. Enabled by default; profiles live under `~/.camofox/profiles/`.

## How It Works

Choose behavior by browser mode:

- Normal contexts: `session:creating` loads `storage-state.json`; lifecycle hooks checkpoint Playwright `storageState()` atomically.
- Native persistent contexts: rely on Firefox `userDataDir` plus session-restore and no-sanitize launch preferences. Never call Playwright `storageState()` or `cookies()` for this mode because Camoufox/Juggler can hang on those requests.
- Persistent contexts retain a blank final page when callers close their last managed tab. Closing Firefox's final page terminates the persistent browser process before session state can flush.
- Checkpoint requests in native persistent mode write metadata and return `reason: "native-profile"` without a browser-protocol export.
- One native persistent sidecar/profile is one browser-identity trust boundary: every logical `userId` attached to that sidecar shares its cookies and localStorage. Use a separate sidecar and `userDataDir` when identities must be isolated.

Lifecycle hooks are async and awaited through `emitAsync()`.

## Key Files

- `index.js` — lifecycle hooks and authenticated checkpoint routes
- `../../lib/persistence.js` — normal-context storage-state writes and native-profile checkpoint metadata
- `../../lib/persistent-context.js` — persistent-context adapter, Firefox durability preferences, and last-page guard
- `persistence.test.js` — helper tests
- `plugin.test.js` — lifecycle and route-registration tests

## Storage Layout

Normal contexts:

```text
~/.camofox/profiles/
└── <sha256(userId)>/
    ├── storage-state.json
    └── meta.json
```

Native persistent contexts store browser data in the configured `CAMOFOX_USER_DATA_DIR`; hashed user directories contain checkpoint metadata only.

## Configuration

Enabled by default. Override the profile root with `CAMOFOX_PROFILE_DIR` or `"profileDir"` in plugin config. Disable with `"persistence": { "enabled": false }`.

## Original Contributors

- [@company8](https://github.com/company8) — original persistence concept ([PR #62](https://github.com/jo-inc/camofox-browser/pull/62))
- [@eddieoz](https://github.com/eddieoz) — cookie auto-load on startup ([PR #55](https://github.com/jo-inc/camofox-browser/pull/55))
- [@pradeepe](https://github.com/pradeepe) — plugin system integration, atomic writes, inflight coalescing

For PRs touching this plugin, tag the contributors above for review.
