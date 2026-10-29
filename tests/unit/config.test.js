import { describe, expect, test, afterEach } from '@jest/globals';
import fs from 'fs';
import os from 'os';
import path from 'path';
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

  test('validates the configured proxy protocol', () => {
    process.env.PROXY_PROTOCOL = 'socks5';
    expect(loadConfig().proxy.protocol).toBe('socks5');

    process.env.PROXY_PROTOCOL = 'ftp';
    expect(() => loadConfig()).toThrow('PROXY_PROTOCOL must be http, https, socks4, or socks5');
  });

  test('configures an optional direct browser identity and forwards it to subprocesses', () => {
    process.env.CAMOFOX_LOCALE = 'en-AU';
    process.env.CAMOFOX_TIMEZONE = 'Australia/Sydney';

    const config = loadConfig();

    expect(config.directIdentity).toEqual({ locale: 'en-AU', timezoneId: 'Australia/Sydney' });
    expect(config.serverEnv.CAMOFOX_LOCALE).toBe('en-AU');
    expect(config.serverEnv.CAMOFOX_TIMEZONE).toBe('Australia/Sydney');
  });

  test('does not set a direct browser identity unless both values are configured', () => {
    delete process.env.CAMOFOX_LOCALE;
    delete process.env.CAMOFOX_TIMEZONE;
    expect(loadConfig().directIdentity).toBeNull();

    process.env.CAMOFOX_LOCALE = 'en-AU';
    expect(() => loadConfig()).toThrow('CAMOFOX_LOCALE and CAMOFOX_TIMEZONE must be set together');

    process.env.CAMOFOX_TIMEZONE = 'Not/A_Timezone';
    expect(() => loadConfig()).toThrow('CAMOFOX_TIMEZONE must be a valid IANA timezone');
  });

  test('configures an optional fingerprint OS and forwards it to subprocesses', () => {
    delete process.env.CAMOFOX_OS;
    expect(loadConfig().fingerprintOs).toBeNull();

    process.env.CAMOFOX_OS = 'Windows';
    const config = loadConfig();
    expect(config.fingerprintOs).toBe('windows');
    expect(config.serverEnv.CAMOFOX_OS).toBe('Windows');

    process.env.CAMOFOX_OS = 'android';
    expect(() => loadConfig()).toThrow('CAMOFOX_OS must be windows, macos, or linux');
  });

  test('configures and forwards the upload directory', () => {
    process.env.CAMOFOX_UPLOADS_DIR = '/mounted/uploads';

    const config = loadConfig();

    expect(config.uploadsDir).toBe('/mounted/uploads');
    expect(config.serverEnv.CAMOFOX_UPLOADS_DIR).toBe('/mounted/uploads');
  });

  test('configures and forwards the evaluate body size limit', () => {
    delete process.env.CAMOFOX_EVALUATE_MAX_BODY_SIZE;
    expect(loadConfig().evaluateMaxBodySize).toBe('1mb');

    process.env.CAMOFOX_EVALUATE_MAX_BODY_SIZE = '10mb';
    const config = loadConfig();
    expect(config.evaluateMaxBodySize).toBe('10mb');
    expect(config.serverEnv.CAMOFOX_EVALUATE_MAX_BODY_SIZE).toBe('10mb');
  });

  test('preserves zero timeout values to disable session expiry and idle shutdown', () => {
    process.env.SESSION_TIMEOUT_MS = '0';
    process.env.BROWSER_IDLE_TIMEOUT_MS = '0';

    const config = loadConfig();

    expect(config.sessionTimeoutMs).toBe(0);
    expect(config.browserIdleTimeoutMs).toBe(0);
  });

  test('uses default timeout values when timeout environment variables are unset or invalid', () => {
    delete process.env.SESSION_TIMEOUT_MS;
    delete process.env.BROWSER_IDLE_TIMEOUT_MS;
    expect(loadConfig().sessionTimeoutMs).toBe(600000);
    expect(loadConfig().browserIdleTimeoutMs).toBe(300000);

    process.env.SESSION_TIMEOUT_MS = 'not-a-number';
    process.env.BROWSER_IDLE_TIMEOUT_MS = 'not-a-number';
    expect(loadConfig().sessionTimeoutMs).toBe(600000);
    expect(loadConfig().browserIdleTimeoutMs).toBe(300000);
  });

  test('configures browser RSS restart threshold', () => {
    delete process.env.BROWSER_RSS_RESTART_THRESHOLD_MB;
    expect(loadConfig().browserRssRestartThresholdMb).toBe(1500);

    process.env.BROWSER_RSS_RESTART_THRESHOLD_MB = '2048';
    expect(loadConfig().browserRssRestartThresholdMb).toBe(2048);
  });

  test('configures and forwards navigation timeout', () => {
    delete process.env.NAVIGATE_TIMEOUT_MS;
    expect(loadConfig().navigateTimeoutMs).toBe(30000);

    process.env.NAVIGATE_TIMEOUT_MS = '60000';
    const config = loadConfig();
    expect(config.navigateTimeoutMs).toBe(60000);
    expect(config.serverEnv.NAVIGATE_TIMEOUT_MS).toBe('60000');
  });

  test('reads newPageTimeoutMs from camofox.config.json with a 10s fallback', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'camofox-config-'));
    const configPath = path.join(dir, 'camofox.config.json');

    fs.writeFileSync(configPath, JSON.stringify({ newPageTimeoutMs: 15000 }));
    expect(loadConfig({ configPath }).newPageTimeoutMs).toBe(15000);

    fs.writeFileSync(configPath, JSON.stringify({ newPageTimeoutMs: 0 }));
    expect(loadConfig({ configPath }).newPageTimeoutMs).toBe(10000);

    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('enables desktop interactive mode from the environment and forwards it to server subprocesses', () => {
    process.env.CAMOFOX_INTERACTIVE = 'desktop';

    const config = loadConfig();

    expect(config.interactiveMode).toBe('desktop');
    expect(config.serverEnv.CAMOFOX_INTERACTIVE).toBe('desktop');
  });

  test('reads interactive mode from camofox.config.json and rejects invalid modes', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'camofox-config-'));
    const configPath = path.join(dir, 'camofox.config.json');

    fs.writeFileSync(configPath, JSON.stringify({ interactive: { mode: 'desktop' } }));
    expect(loadConfig({ configPath }).interactiveMode).toBe('desktop');

    fs.writeFileSync(configPath, JSON.stringify({ interactive: { mode: 'surprise' } }));
    expect(loadConfig({ configPath }).interactiveMode).toBe('off');
    fs.rmSync(dir, { recursive: true, force: true });
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
