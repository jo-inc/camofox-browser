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

  test('configures and forwards browser locale and timezone settings', () => {
    process.env.CAMOFOX_LOCALE = ' ru-RU ';
    process.env.CAMOFOX_LOCALES = ' ru-RU,ru ';
    process.env.CAMOFOX_TIMEZONE = ' Europe/Moscow ';

    const config = loadConfig();

    expect(config.locale).toBe('ru-RU');
    expect(config.locales).toBe('ru-RU,ru');
    expect(config.timezoneId).toBe('Europe/Moscow');
    expect(config.serverEnv.CAMOFOX_LOCALE).toBe(' ru-RU ');
    expect(config.serverEnv.CAMOFOX_LOCALES).toBe(' ru-RU,ru ');
    expect(config.serverEnv.CAMOFOX_TIMEZONE).toBe(' Europe/Moscow ');
  });

  test('keeps compatible browser locale and timezone defaults', () => {
    delete process.env.CAMOFOX_LOCALE;
    delete process.env.CAMOFOX_LOCALES;
    delete process.env.CAMOFOX_TIMEZONE;

    const config = loadConfig();

    expect(config.locale).toBe('en-US');
    expect(config.locales).toBe('en-US');
    expect(config.timezoneId).toBe('America/Los_Angeles');
  });

  test('derives the context locale from the launch locale list', () => {
    delete process.env.CAMOFOX_LOCALE;
    process.env.CAMOFOX_LOCALES = ' ru-RU,ru ';

    const config = loadConfig();

    expect(config.locale).toBe('ru-RU');
    expect(config.locales).toBe('ru-RU,ru');
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

  test('configures browser RSS restart threshold', () => {
    delete process.env.BROWSER_RSS_RESTART_THRESHOLD_MB;
    expect(loadConfig().browserRssRestartThresholdMb).toBe(1500);

    process.env.BROWSER_RSS_RESTART_THRESHOLD_MB = '2048';
    expect(loadConfig().browserRssRestartThresholdMb).toBe(2048);
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
