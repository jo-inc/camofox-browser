import { describe, expect, test, afterEach } from '@jest/globals';
import { loadConfig } from '../../lib/config.js';

const ORIGINAL_ENV = { ...process.env };

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

describe('loadConfig', () => {
  test('prefers CAMOUFOX_EXECUTABLE for external Camoufox executable', () => {
    process.env.CAMOUFOX_EXECUTABLE = '/nix/store/camoufox/bin/camoufox';
    process.env.CAMOUFOX_EXECUTABLE_PATH = '/ignored/camoufox';
    process.env.CAMOFOX_EXECUTABLE_PATH = '/also-ignored/camoufox';

    const config = loadConfig();

    expect(config.camoufoxExecutablePath).toBe('/nix/store/camoufox/bin/camoufox');
    expect(config.serverEnv.CAMOUFOX_EXECUTABLE).toBe('/nix/store/camoufox/bin/camoufox');
    expect(config.serverEnv.CAMOUFOX_EXECUTABLE_PATH).toBe('/ignored/camoufox');
    expect(config.serverEnv.CAMOFOX_EXECUTABLE_PATH).toBe('/also-ignored/camoufox');
  });

  test('accepts compatibility executable env vars', () => {
    process.env.CAMOUFOX_EXECUTABLE_PATH = '/compat/camoufox';
    expect(loadConfig().camoufoxExecutablePath).toBe('/compat/camoufox');

    delete process.env.CAMOUFOX_EXECUTABLE_PATH;
    process.env.CAMOFOX_EXECUTABLE_PATH = '/legacy/camoufox';
    expect(loadConfig().camoufoxExecutablePath).toBe('/legacy/camoufox');
  });

  test('configures browser RSS restart threshold', () => {
    delete process.env.BROWSER_RSS_RESTART_THRESHOLD_MB;
    expect(loadConfig().browserRssRestartThresholdMb).toBe(1500);

    process.env.BROWSER_RSS_RESTART_THRESHOLD_MB = '2048';
    expect(loadConfig().browserRssRestartThresholdMb).toBe(2048);
  });

  test('preserves zero browser idle timeout and falls back for invalid values', () => {
    delete process.env.BROWSER_IDLE_TIMEOUT_MS;
    expect(loadConfig().browserIdleTimeoutMs).toBe(300000);

    process.env.BROWSER_IDLE_TIMEOUT_MS = 'not-a-number';
    expect(loadConfig().browserIdleTimeoutMs).toBe(300000);

    process.env.BROWSER_IDLE_TIMEOUT_MS = '0';
    expect(loadConfig().browserIdleTimeoutMs).toBe(0);
  });

  test('disables default addons when CAMOFOX_DISABLE_DEFAULT_ADDONS is set', () => {
    delete process.env.CAMOFOX_DISABLE_DEFAULT_ADDONS;
    expect(loadConfig().disableDefaultAddons).toBe(false);

    process.env.CAMOFOX_DISABLE_DEFAULT_ADDONS = '0';
    expect(loadConfig().disableDefaultAddons).toBe(false);

    process.env.CAMOFOX_DISABLE_DEFAULT_ADDONS = '1';
    expect(loadConfig().disableDefaultAddons).toBe(true);

    process.env.CAMOFOX_DISABLE_DEFAULT_ADDONS = 'true';
    const config = loadConfig();
    expect(config.disableDefaultAddons).toBe(true);
    expect(config.serverEnv.CAMOFOX_DISABLE_DEFAULT_ADDONS).toBe('true');
  });

  test('forwards VNC env vars to server subprocess whitelist', () => {
    process.env.ENABLE_VNC = '1';
    process.env.VNC_RESOLUTION = '1280x720';
    process.env.VNC_PASSWORD = 'secret';
    process.env.VIEW_ONLY = '1';
    process.env.VNC_PORT = '5901';
    process.env.NOVNC_PORT = '6081';
    process.env.VNC_BIND = '0.0.0.0';

    const config = loadConfig();

    expect(config.pluginEnv).toEqual({ ENABLE_VNC: '1' });
    expect(config.serverEnv).toMatchObject({
      ENABLE_VNC: '1',
      VNC_RESOLUTION: '1280x720',
      VNC_PASSWORD: 'secret',
      VIEW_ONLY: '1',
      VNC_PORT: '5901',
      NOVNC_PORT: '6081',
      VNC_BIND: '0.0.0.0',
    });
  });
});
