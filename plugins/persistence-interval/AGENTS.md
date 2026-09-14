# Persistence Interval Plugin — Agent Guide

Bounds crash-window data loss for the [persistence](../persistence/) plugin by checkpointing live sessions on a timer. Off unless `intervalMs` is configured. Not enabled in the shipped `camofox.config.json`.

## How It Works

- `setInterval(intervalMs)` → iterates `ctx.sessions`, calls `context.storageState(ctx.persistenceStorageStateOptions)`, emits `session:storage:export` per session
- The `persistence` plugin's listener does the actual write — this plugin never touches the filesystem
- `server:shutdown` → clears the timer

Uses only the public plugin context (`ctx.events`, `ctx.sessions`, `ctx.log`). No core changes, no routes, no `child_process`.

## Invariants

- Zero or missing `intervalMs` means off, not "restore a default" — a default here would be a busy loop
- Per-session `try`/`catch`: one dead context must not skip the others or kill the timer
- `ctx.persistenceStorageStateOptions` is read at tick time, not register time, so plugin load order does not matter
- `sessions.entries()` is snapshotted before iterating, since a session may be destroyed mid-loop
- Timer is `unref()`'d so it never holds the process open

## Key Files

- `index.js` — the interval registration (no routes, no `child_process`)
- `plugin.test.js` — unit tests for the register/tick/shutdown lifecycle

## Related

Timer-based checkpointing in core was declined in [#7223](https://github.com/jo-inc/camofox-browser/pull/7223); this plugin is the out-of-core form that discussion suggested.
