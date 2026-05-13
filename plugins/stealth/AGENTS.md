# Stealth Plugin — Agent Guide

Plugs leaks in the default camoufox launch that fingerprinting suites
(sannysoft, creepjs, browserleaks) reliably catch when no residential
proxy is configured.

## How It Works

- `browser:launching` hook → mutates `options.firefoxUserPrefs`:
  - Disables WebRTC (`media.peerconnection.enabled = false`) and tightens
    ICE so even if WebRTC were re-enabled it can't reveal host candidates.
  - Sets `intl.accept_languages` so HTTP `Accept-Language` matches the
    configured locale.
- `session:creating` hook → mutates `contextOptions`:
  - `locale`, `timezoneId`, `geolocation` — only when the corresponding
    config keys are set. Empty config = passthrough.

All overrides are last-write-wins after core's defaults, so the plugin
cleanly replaces the hardcoded LA/en-US/SF block when no proxy is in use.

## Key Files

- `index.js` — both hooks, no routes, no I/O
- `plugin.test.js` — integration tests covering each config knob and the
  passthrough case

## Limitation Worth Knowing

The `browser:launching` hook fires AFTER camoufox-js's `launchOptions()`
returns. That means `options.os`, `options.humanize`, `options.geoip`
have already been turned into Playwright launch args / firefoxUserPrefs.
Pref overrides here are last-write-wins, but the `os` selection (which
drives navigator.platform, UA family, WebGL renderer) is baked too
deeply to flip from a plugin. To change that, core needs to pick a
different `os` upstream of this hook.

## When to Update This Plugin

- Add a new knob — extend `cfg` in `index.js`, add an env-var, add a hook
  branch, update README, add a test asserting both the env path and the
  config path.
- Don't add knobs that aren't reachable from outside the box (no `app.get`
  routes — this plugin is hook-only).
