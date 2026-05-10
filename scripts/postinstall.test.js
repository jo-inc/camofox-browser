import { afterEach, describe, expect, test } from '@jest/globals';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { spawnSync } from 'child_process';
import { dirname } from 'path';
import { fileURLToPath } from 'url';
import { externalExecutableFromEnv } from './postinstall.js';

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
    const result = spawnSync(process.execPath, ['scripts/postinstall.js'], {
      cwd: join(__dirname, '..'),
      encoding: 'utf8',
      env: {
        ...process.env,
        CAMOUFOX_EXECUTABLE: executable,
        PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD: '1',
      },
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('skipping bundled Camoufox download');
    expect(result.stderr).toBe('');
  });
});
