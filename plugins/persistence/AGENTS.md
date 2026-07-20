# Persistence Plugin — Agent Guide

Saves and restores per-user browser storage state (cookies + localStorage, with optional IndexedDB) across session restarts using Playwright's `storageState` API. Enabled by default — profiles persist to `~/.camofox/profiles/`.

## How It Works

- `session:creating` hook → loads saved `storage_state.json` into `contextOptions.storageState`
- `session:created` hook → imports bootstrap cookies if no persisted state exists
- `session:cookies:import` / `session:destroyed` / `server:shutdown` → checkpoints state to disk
- `DELETE /sessions/:userId/storage_state` → closes the live context without checkpointing and removes persisted state

All hooks are async and awaited via `emitAsync()` — storage state is guaranteed loaded before the context is created.

## Key Files

- `index.js` — lifecycle hooks (no routes, no `child_process`)
- `persistence.test.js` — unit tests for `lib/persistence.js` helpers
- `plugin.test.js` — integration tests for plugin lifecycle hooks

## Storage Layout

```
~/.camofox/profiles/
└── <sha256(userId)>/
    └── storage_state.json
```

## Configuration

Enabled by default. Override profile directory with `CAMOFOX_PROFILE_DIR` env var or `"profileDir"` in plugin config. To disable: `"persistence": { "enabled": false }` in `camofox.config.json`.

IndexedDB persistence is opt-in (`"indexedDB": true` in the persistence plugin config). It captures all serializable IndexedDB records, not only authentication data, and may make snapshots significantly larger and checkpoints slower.

## Original Contributors

- [@company8](https://github.com/company8) — original persistence concept ([PR #62](https://github.com/jo-inc/camofox-browser/pull/62))
- [@eddieoz](https://github.com/eddieoz) — cookie auto-load on startup ([PR #55](https://github.com/jo-inc/camofox-browser/pull/55))
- [@pradeepe](https://github.com/pradeepe) — plugin system integration, atomic writes, inflight coalescing

For PRs touching this plugin, tag the contributors above for review.
