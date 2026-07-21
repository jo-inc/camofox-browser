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

  test('rejects zero, negative, and malformed admission limits safely', () => {
    process.env.HANDLER_TIMEOUT_MS = '0';
    process.env.MAX_CONCURRENT_PER_USER = '3oops';
    process.env.MAX_TABS_GLOBAL = '0';
    process.env.MAX_TABS_PER_SESSION = '-5';
    process.env.TAB_ADMISSION_MAX_ACTIVE = '0';
    process.env.TAB_ADMISSION_MAX_ACTIVE_PER_USER = '-2';
    process.env.TAB_ADMISSION_QUEUE_LIMIT = 'NaN';

    const config = loadConfig();

    expect(config.handlerTimeoutMs).toBe(30000);
    expect(config.maxConcurrentPerUser).toBe(3);
    expect(config.maxTabsGlobal).toBe(50);
    expect(config.maxTabsPerSession).toBe(10);
    expect(config.tabAdmissionMaxActive).toBe(4);
    expect(config.tabAdmissionMaxActivePerUser).toBe(2);
    expect(config.tabAdmissionQueueLimit).toBe(8);
  });

  test('accepts positive admission-control values', () => {
    process.env.HANDLER_TIMEOUT_MS = '1500';
    process.env.MAX_CONCURRENT_PER_USER = '4';
    process.env.MAX_TABS_GLOBAL = '12';
    process.env.MAX_TABS_PER_SESSION = '8';
    process.env.TAB_ADMISSION_MAX_ACTIVE = '6';
    process.env.TAB_ADMISSION_MAX_ACTIVE_PER_USER = '3';
    process.env.TAB_ADMISSION_QUEUE_LIMIT = '5';

    const config = loadConfig();

    expect(config.handlerTimeoutMs).toBe(1500);
    expect(config.maxConcurrentPerUser).toBe(4);
    expect(config.maxTabsGlobal).toBe(12);
    expect(config.maxTabsPerSession).toBe(8);
    expect(config.tabAdmissionMaxActive).toBe(6);
    expect(config.tabAdmissionMaxActivePerUser).toBe(3);
    expect(config.tabAdmissionQueueLimit).toBe(5);
    expect(config.serverEnv).toMatchObject({
      HANDLER_TIMEOUT_MS: '1500',
      MAX_CONCURRENT_PER_USER: '4',
      MAX_TABS_GLOBAL: '12',
      MAX_TABS_PER_SESSION: '8',
      TAB_ADMISSION_MAX_ACTIVE: '6',
      TAB_ADMISSION_MAX_ACTIVE_PER_USER: '3',
      TAB_ADMISSION_QUEUE_LIMIT: '5',
    });
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
