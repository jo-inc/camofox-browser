import { describe, expect, test, afterEach } from '@jest/globals';
import { loadConfig } from '../../lib/config.js';

const ORIGINAL_ENV = { ...process.env };

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

describe('loadConfig', () => {
  test('reads the optional API bind host and forwards it to server subprocesses', () => {
    process.env.CAMOFOX_BIND_HOST = '127.0.0.1';

    const config = loadConfig();

    expect(config.bindHost).toBe('127.0.0.1');
    expect(config.serverEnv.CAMOFOX_BIND_HOST).toBe('127.0.0.1');
  });

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

});
