# persistence

Optional browser storage persistence for camofox-browser.

## Configuration

In `camofox.config.json`:

```json
{
  "plugins": {
    "persistence": {
      "enabled": true,
      "profileDir": "/data/profiles"
    }
  }
}
```

Or override the profile root:

```text
CAMOFOX_PROFILE_DIR=/data/profiles
```

## How it works

The persistence mechanism follows the browser mode:

- **Normal browser contexts:** per-user cookies and localStorage are saved with Playwright `storageState`, using an atomic temporary-file rename, and restored through `contextOptions.storageState`.
- **Native persistent Firefox contexts:** Firefox owns cookie, localStorage, and session-store durability in its `userDataDir`. Launch preferences enable session restore, preserve HTTPS session cookies, and disable cookie/session sanitization on shutdown. Playwright `storageState()` and `cookies()` are deliberately not called in this mode because Camoufox/Juggler can hang on those protocol requests. One sidecar/profile is one browser-identity trust boundary; every logical `userId` attached to it shares browser state, so use separate sidecars and `userDataDir` values for isolated identities.
- **Last-page handling:** closing the final managed page retains a blank keeper page so Firefox does not terminate before session state is flushed.
- **First run:** if no prior per-user state exists, bootstrap cookies from `CAMOFOX_COOKIES_DIR/cookies.txt` are imported when configured.
- **User isolation:** normal-context state uses a deterministic SHA256-hashed subdirectory per `userId`, preventing path traversal.

For native persistent contexts, checkpoint endpoints return `persisted: true` with `reason: "native-profile"`; this confirms that durability is delegated to the configured Firefox profile rather than attempting a protocol export.

## Docker

Mount the profile directory as a volume:

```bash
docker run -d \
  -p 9377:9377 \
  -v /host/profiles:/data/profiles \
  camofox-browser
```

## Credits

Based on PR #62 by [company8](https://github.com/company8).
