import { jest } from '@jest/globals';
import { createPluginEvents } from '../../lib/plugins.js';
import { register } from './index.js';

const STEALTH_ENV_KEYS = [
  'CAMOFOX_STEALTH_LOCALE',
  'CAMOFOX_STEALTH_TZ',
  'CAMOFOX_STEALTH_GEO_LAT',
  'CAMOFOX_STEALTH_GEO_LON',
  'CAMOFOX_STEALTH_BLOCK_WEBRTC',
];

describe('stealth plugin', () => {
  let events, ctx, mockApp, originalEnv;

  beforeEach(() => {
    events = createPluginEvents();
    mockApp = {};
    ctx = {
      events,
      config: {},
      log: jest.fn(),
    };
    originalEnv = {};
    for (const k of STEALTH_ENV_KEYS) {
      originalEnv[k] = process.env[k];
      delete process.env[k];
    }
  });

  afterEach(() => {
    for (const k of STEALTH_ENV_KEYS) {
      if (originalEnv[k] === undefined) delete process.env[k];
      else process.env[k] = originalEnv[k];
    }
  });

  test('blocks WebRTC via firefoxUserPrefs by default', async () => {
    await register(mockApp, ctx, { enabled: true });

    const options = {};
    await events.emitAsync('browser:launching', { options });

    expect(options.firefoxUserPrefs['media.peerconnection.enabled']).toBe(false);
    expect(options.firefoxUserPrefs['media.peerconnection.ice.no_host']).toBe(true);
    expect(options.firefoxUserPrefs['media.peerconnection.ice.proxy_only_if_behind_proxy']).toBe(true);
  });

  test('honors blockWebrtc=false to leave WebRTC enabled', async () => {
    await register(mockApp, ctx, { blockWebrtc: false });

    const options = { firefoxUserPrefs: {} };
    await events.emitAsync('browser:launching', { options });

    expect(options.firefoxUserPrefs['media.peerconnection.enabled']).toBeUndefined();
  });

  test('CAMOFOX_STEALTH_BLOCK_WEBRTC=0 overrides config to leave WebRTC enabled', async () => {
    process.env.CAMOFOX_STEALTH_BLOCK_WEBRTC = '0';
    await register(mockApp, ctx, { blockWebrtc: true });

    const options = { firefoxUserPrefs: {} };
    await events.emitAsync('browser:launching', { options });

    expect(options.firefoxUserPrefs['media.peerconnection.enabled']).toBeUndefined();
  });

  test('sets intl.accept_languages when locale configured', async () => {
    await register(mockApp, ctx, { locale: 'en-GB' });

    const options = {};
    await events.emitAsync('browser:launching', { options });

    expect(options.firefoxUserPrefs['intl.accept_languages']).toBe('en-GB,en');
  });

  test('leaves Accept-Language alone when no locale configured', async () => {
    await register(mockApp, ctx, {});

    const options = {};
    await events.emitAsync('browser:launching', { options });

    expect(options.firefoxUserPrefs['intl.accept_languages']).toBeUndefined();
  });

  test('overrides session contextOptions.locale, timezoneId, and geolocation', async () => {
    await register(mockApp, ctx, {
      locale: 'en-GB',
      timezone: 'Europe/London',
      geoLat: 51.5074,
      geoLon: -0.1278,
    });

    const contextOptions = { locale: 'en-US', timezoneId: 'America/Los_Angeles', geolocation: { latitude: 0, longitude: 0 } };
    await events.emitAsync('session:creating', { userId: 'u', contextOptions });

    expect(contextOptions.locale).toBe('en-GB');
    expect(contextOptions.timezoneId).toBe('Europe/London');
    expect(contextOptions.geolocation).toEqual({ latitude: 51.5074, longitude: -0.1278 });
  });

  test('environment overrides plugin config for locale / TZ / geo', async () => {
    process.env.CAMOFOX_STEALTH_LOCALE = 'fr-FR';
    process.env.CAMOFOX_STEALTH_TZ = 'Europe/Paris';
    process.env.CAMOFOX_STEALTH_GEO_LAT = '48.8566';
    process.env.CAMOFOX_STEALTH_GEO_LON = '2.3522';

    await register(mockApp, ctx, {
      locale: 'en-GB',
      timezone: 'Europe/London',
      geoLat: 51.5074,
      geoLon: -0.1278,
    });

    const contextOptions = {};
    await events.emitAsync('session:creating', { userId: 'u', contextOptions });

    expect(contextOptions.locale).toBe('fr-FR');
    expect(contextOptions.timezoneId).toBe('Europe/Paris');
    expect(contextOptions.geolocation).toEqual({ latitude: 48.8566, longitude: 2.3522 });
  });

  test('passthrough: leaves contextOptions untouched when nothing configured', async () => {
    await register(mockApp, ctx, {});

    const contextOptions = { locale: 'en-US', timezoneId: 'America/Los_Angeles', geolocation: { latitude: 1, longitude: 2 } };
    await events.emitAsync('session:creating', { userId: 'u', contextOptions });

    expect(contextOptions.locale).toBe('en-US');
    expect(contextOptions.timezoneId).toBe('America/Los_Angeles');
    expect(contextOptions.geolocation).toEqual({ latitude: 1, longitude: 2 });
  });

  test('partial config only overrides the specified keys', async () => {
    await register(mockApp, ctx, { timezone: 'Europe/London' });

    const contextOptions = { locale: 'en-US', timezoneId: 'America/Los_Angeles', geolocation: { latitude: 1, longitude: 2 } };
    await events.emitAsync('session:creating', { userId: 'u', contextOptions });

    expect(contextOptions.locale).toBe('en-US');
    expect(contextOptions.timezoneId).toBe('Europe/London');
    expect(contextOptions.geolocation).toEqual({ latitude: 1, longitude: 2 });
  });
});
