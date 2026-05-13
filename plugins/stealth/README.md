# stealth

Hardens the fingerprint and IP-leak surface of camofox-browser for cases
where a residential proxy is not in use.

## What it does

- **Disables WebRTC entirely** via Firefox prefs. Closes the public-IP leak
  exposed by STUN srflx candidates — the most common single fingerprint
  signal beyond the UA, and not fixable via HTTP proxy alone.
- **Overrides per-session locale, timezone, and geolocation.** With no proxy,
  core sets these to `en-US` / `America/Los_Angeles` / SF; this plugin lets
  you choose any value (or leave them untouched).
- **Sets `intl.accept_languages`** to match the chosen locale, so HTTP
  `Accept-Language` headers don't lie about the configured locale.

## Configuration

In `camofox.config.json`:

```json
{
  "plugins": {
    "stealth": {
      "enabled": true,
      "locale": "en-GB",
      "timezone": "Europe/London",
      "geoLat": 51.5074,
      "geoLon": -0.1278,
      "blockWebrtc": true
    }
  }
}
```

Or override via environment variables (highest precedence):

| Var | Format | Example |
| --- | --- | --- |
| `CAMOFOX_STEALTH_LOCALE` | BCP-47 tag | `en-GB` |
| `CAMOFOX_STEALTH_TZ` | IANA TZ name | `Europe/London` |
| `CAMOFOX_STEALTH_GEO_LAT` | float | `51.5074` |
| `CAMOFOX_STEALTH_GEO_LON` | float | `-0.1278` |
| `CAMOFOX_STEALTH_BLOCK_WEBRTC` | `"0"` to disable | `0` |

Anything not configured is left at core's default — the plugin only mutates
the fields you ask it to.

## How it works

Two lifecycle hooks:

- **`browser:launching`** — mutates `options.firefoxUserPrefs` to disable
  WebRTC (`media.peerconnection.enabled`, `...ice.no_host`,
  `...ice.proxy_only_if_behind_proxy`) and to set
  `intl.accept_languages`.
- **`session:creating`** — mutates `contextOptions.locale`,
  `contextOptions.timezoneId`, `contextOptions.geolocation` per the config.

## Limitations

The `browser:launching` hook fires **after** camoufox-js's `launchOptions()`
has already baked the `os` choice into Playwright launch args. This plugin
therefore cannot change `navigator.platform`, the UA family, or WebGL
renderer — those depend on core picking a different `os` value upstream of
this hook.

## Verifying

Quick before/after on a configured stealth instance:

- WebRTC IP leak — visit `https://browserleaks.com/webrtc`. With
  `blockWebrtc: true` the host/srflx candidate fields are empty.
- Timezone / locale — visit `https://abrahamjuliot.github.io/creepjs/` and
  look at the Timezone and Intl sections; they should reflect the
  configured values.
- Geolocation — visit `https://browserleaks.com/geo` (allow geolocation
  permission). The reported lat/lon should match `geoLat` / `geoLon`.
