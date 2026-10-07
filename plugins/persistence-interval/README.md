# persistence-interval

Optional periodic storage-state checkpointing for camofox-browser.

The [persistence](../persistence/) plugin writes storage state on bootstrap cookie import, cookie import, storage export, session teardown and server shutdown — and on no timer. Any ungraceful termination (SIGKILL, OOM kill, browser crash, host reboot) loses every cookie and origin entry accumulated since the session was created, because none of those events fire. The exposure window is the session lifetime, so it grows with `SESSION_TIMEOUT_MS`.

This plugin bounds that window to a configurable interval. It is off unless configured.

## Configuration

In `camofox.config.json`:

```json
{
  "plugins": {
    "persistence-interval": { "enabled": true, "intervalMs": 300000 }
  }
}
```

- `intervalMs` — how often to checkpoint every live session, in milliseconds. Omitted, zero or non-numeric means off.

Requires the `persistence` plugin to be enabled; this plugin produces the snapshot, persistence writes it.

## How it works

On each tick it iterates live sessions, calls `context.storageState()`, and emits `session:storage:export` — the same event the [vnc](../vnc/) plugin's `GET /sessions/:userId/storage_state` emits. The persistence plugin's existing listener does the writing, so there is exactly one code path touching the profile on disk, and periodic checkpoints reuse the same atomic tmp-write + rename.

Because persistence already serialises checkpoints per `userId`, a periodic checkpoint cannot race an event-driven one.

A side effect worth noting: on-demand checkpointing is otherwise only reachable through the vnc plugin's route, and vnc ships disabled. This plugin gives a deployment running persistence without vnc a way to get state to disk before teardown.

## Trade-offs

Checkpointing on a timer serialises storage state whether or not it has changed. Cost scales with session count and snapshot size, and `indexedDB: true` on the persistence plugin makes each snapshot substantially larger. Pick an interval that reflects how much loss is acceptable, rather than the smallest one that works. Timer-based checkpointing in core was declined in #7223 for exactly this reason, which is why this lives outside core.

Errors are swallowed per session and logged: one dead context does not skip the others or stop the timer. The timer is `unref()`'d and cleared on `server:shutdown`.
