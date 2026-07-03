# Persistence Plugin — Agent Guide

Saves and restores per-user browser storage state (cookies + localStorage) across session restarts using Playwright's `storageState` API. Enabled by default — profiles persist to `~/.camofox/profiles/`.

## How It Works

- `session:creating` hook → loads saved `storage_state.json` into `contextOptions.storageState`
- `session:created` hook → imports bootstrap cookies if no persisted state exists
- `session:cookies:import` / `session:destroyed` / `server:shutdown` → checkpoints state to disk
- Optional `checkpointIntervalMs` timer → periodically checkpoints all active sessions, bounding data loss on an ungraceful crash

All hooks are async and awaited via `emitAsync()` — storage state is guaranteed loaded before the context is created. Checkpoints are guarded against overlap per-userId (`checkpointsInFlight`), so the periodic timer and an event-driven checkpoint never race each other.

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

Opt-in periodic checkpointing, default-off (zero behavior change when unset):

- `checkpointIntervalMs` / `CAMOFOX_CHECKPOINT_INTERVAL_MS` — periodic checkpoint interval in ms.

## Original Contributors

- [@company8](https://github.com/company8) — original persistence concept ([PR #62](https://github.com/jo-inc/camofox-browser/pull/62))
- [@eddieoz](https://github.com/eddieoz) — cookie auto-load on startup ([PR #55](https://github.com/jo-inc/camofox-browser/pull/55))
- [@pradeepe](https://github.com/pradeepe) — plugin system integration, atomic writes, inflight coalescing

For PRs touching this plugin, tag the contributors above for review.
