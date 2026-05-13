/**
 * Stealth plugin for camofox-browser.
 *
 * Hardens fingerprint and IP-leak vectors that the default camoufox launch
 * does not address out of the box:
 *
 *   - Disables WebRTC peer connections (kills public-IP leak via STUN
 *     srflx candidates — the most common single fingerprint signal beyond
 *     UA itself, and not fixable via HTTP proxy alone).
 *   - Overrides per-session locale, timezone, and geolocation. When no
 *     proxy is configured, core sets these to en-US / America/Los_Angeles /
 *     SF — this plugin lets you point them anywhere via env or config.
 *   - Sets HTTP Accept-Language to match the chosen locale.
 *
 * Hook points:
 *   - browser:launching   → mutates firefoxUserPrefs (WebRTC kill,
 *                            Accept-Language)
 *   - session:creating    → mutates contextOptions.locale,
 *                            timezoneId, geolocation
 *
 * Both hooks are no-ops when their respective config keys are unset, so the
 * plugin is safe to enable globally with empty config — you only get
 * WebRTC block, nothing else changes.
 *
 * Configuration (camofox.config.json):
 *   {
 *     "plugins": {
 *       "stealth": {
 *         "enabled": true,
 *         "locale": "en-GB",
 *         "timezone": "Europe/London",
 *         "geoLat": 51.5074,
 *         "geoLon": -0.1278,
 *         "blockWebrtc": true
 *       }
 *     }
 *   }
 *
 * Or via environment variables (override config file):
 *   CAMOFOX_STEALTH_LOCALE        BCP-47 locale tag (e.g. "en-GB")
 *   CAMOFOX_STEALTH_TZ            IANA TZ name (e.g. "Europe/London")
 *   CAMOFOX_STEALTH_GEO_LAT       float latitude
 *   CAMOFOX_STEALTH_GEO_LON       float longitude
 *   CAMOFOX_STEALTH_BLOCK_WEBRTC  "0" to leave WebRTC enabled
 *
 * Limitations:
 *   The browser:launching hook fires after camoufox-js's launchOptions() has
 *   already baked the `os` choice into Playwright launch args. This plugin
 *   therefore cannot change navigator.platform, UA family, or WebGL
 *   renderer — those require core to pick a different `os` value.
 */

function numOr(value, fallback) {
  const n = parseFloat(value);
  return Number.isFinite(n) ? n : fallback;
}

function boolFromEnv(value, fallback) {
  if (value === undefined || value === null) return fallback;
  return value !== '0' && value !== 'false';
}

export async function register(app, ctx, pluginConfig = {}) {
  const { events, log } = ctx;

  const cfg = {
    locale: process.env.CAMOFOX_STEALTH_LOCALE || pluginConfig.locale || null,
    timezone: process.env.CAMOFOX_STEALTH_TZ || pluginConfig.timezone || null,
    geoLat: numOr(process.env.CAMOFOX_STEALTH_GEO_LAT, numOr(pluginConfig.geoLat, null)),
    geoLon: numOr(process.env.CAMOFOX_STEALTH_GEO_LON, numOr(pluginConfig.geoLon, null)),
    blockWebrtc: boolFromEnv(
      process.env.CAMOFOX_STEALTH_BLOCK_WEBRTC,
      pluginConfig.blockWebrtc !== false,
    ),
  };

  log('info', 'stealth plugin registered', cfg);

  events.on('browser:launching', ({ options }) => {
    options.firefoxUserPrefs = options.firefoxUserPrefs || {};
    if (cfg.blockWebrtc) {
      options.firefoxUserPrefs['media.peerconnection.enabled'] = false;
      options.firefoxUserPrefs['media.peerconnection.ice.no_host'] = true;
      options.firefoxUserPrefs['media.peerconnection.ice.proxy_only_if_behind_proxy'] = true;
    }
    if (cfg.locale) {
      options.firefoxUserPrefs['intl.accept_languages'] = `${cfg.locale},en`;
    }
  });

  events.on('session:creating', ({ contextOptions }) => {
    if (cfg.locale) contextOptions.locale = cfg.locale;
    if (cfg.timezone) contextOptions.timezoneId = cfg.timezone;
    if (cfg.geoLat !== null && cfg.geoLon !== null) {
      contextOptions.geolocation = { latitude: cfg.geoLat, longitude: cfg.geoLon };
    }
  });
}

export default register;
