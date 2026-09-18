import { afterEach, describe, expect, jest, test } from '@jest/globals';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { spawnSync } from 'child_process';
import { dirname } from 'path';
import { fileURLToPath } from 'url';
import { downloadBundledCamoufox } from '../lib/camoufox-download.js';
import { externalExecutableFromEnv } from '../postinstall.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const tempDirs = [];

function makeExecutable() {
  const dir = mkdtempSync(join(tmpdir(), 'camofox-postinstall-test-'));
  tempDirs.push(dir);
  const executable = join(dir, 'camoufox-bin');
  writeFileSync(executable, '#!/bin/sh\nexit 0\n');
  chmodSync(executable, 0o755);
  return executable;
}

function postinstallTestEnv(overrides = {}) {
  const env = {};
  for (const name of [
    'PATH',
    'Path',
    'HOME',
    'USERPROFILE',
    'APPDATA',
    'LOCALAPPDATA',
    'TMPDIR',
    'TEMP',
    'TMP',
    'SystemRoot',
    'WINDIR',
    'ComSpec',
    'PATHEXT',
  ]) {
    if (process.env[name] !== undefined) env[name] = process.env[name];
  }
  return { ...env, ...overrides };
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('postinstall external executable handling', () => {
  test('uses CAMOUFOX_EXECUTABLE before compatibility aliases', () => {
    expect(externalExecutableFromEnv({
      CAMOUFOX_EXECUTABLE: '/primary',
      CAMOUFOX_EXECUTABLE_PATH: '/compat',
      CAMOFOX_EXECUTABLE_PATH: '/legacy',
    })).toEqual({ name: 'CAMOUFOX_EXECUTABLE', value: '/primary' });
  });

  test('skips bundled download when an external executable is configured', () => {
    const executable = makeExecutable();
    const result = spawnSync(process.execPath, ['postinstall.js'], {
      cwd: join(__dirname, '..'),
      encoding: 'utf8',
      env: postinstallTestEnv({
        CAMOUFOX_EXECUTABLE: executable,
        PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD: '1',
      }),
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('skipping bundled Camoufox download');
    expect(result.stderr).toBe('');
  });
});

describe('postinstall downloader', () => {
  test('uses camoufox-js without a package-owned child process', async () => {
    const install = jest.fn().mockResolvedValue(undefined);
    const downloadGeoIp = jest.fn();
    const downloadAddons = jest.fn().mockResolvedValue(undefined);

    await downloadBundledCamoufox({
      createFetcher: () => ({ install }),
      shouldDownloadGeoIp: true,
      downloadGeoIp,
      downloadAddons,
    });

    expect(install).toHaveBeenCalledTimes(1);
    expect(downloadGeoIp).toHaveBeenCalledTimes(1);
    expect(downloadAddons).toHaveBeenCalledTimes(1);
  });
});
