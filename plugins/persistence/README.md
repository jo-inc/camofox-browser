# persistence

Optional per-user browser storage state persistence for camofox-browser.

Saves and restores cookies + localStorage across session restarts, container deploys, and idle timeouts using Playwright's `storageState` API.

## Configuration

In `camofox.config.json`:

```json
{
  "plugins": {
    "persistence": {
      "enabled": true,
      "profileDir": "/data/profiles",
      "checkpointIntervalMs": 60000
    }
  }
}
```

Or override via environment variables:

```
CAMOFOX_PROFILE_DIR=/data/profiles
CAMOFOX_CHECKPOINT_INTERVAL_MS=60000
```

- `checkpointIntervalMs` (default: off) — when set to a positive number, all active sessions are additionally checkpointed on a timer, bounding data loss on an ungraceful crash (OOM/SIGKILL) to the checkpoint interval instead of everything since the last teardown.

## How it works

- **Session create**: If a persisted `storageState` exists for the `userId`, it's restored into the new Playwright context.
- **First run**: If no persisted state exists, bootstrap cookies from `CAMOFOX_COOKIES_DIR/cookies.txt` are imported (if present).
- **Cookie import / session close / shutdown**: Storage state is checkpointed to disk via atomic tmp-write + rename.
- **Periodic (opt-in)**: If `checkpointIntervalMs` is set, all active sessions are also checkpointed on that interval.
- **User isolation**: Each `userId` maps to a deterministic SHA256-hashed subdirectory under `profileDir`, so arbitrary userIds are path-safe.

## Docker

When running with Docker, mount the profile directory as a volume:

```bash
docker run -d \
  -p 9377:9377 \
  -v /host/profiles:/data/profiles \
  camofox-browser
```

## Credits

Based on PR #62 by [company8](https://github.com/company8).
