#!/usr/bin/env node
// Postinstall: download Camoufox binaries and verify the cache is populated.
//
// Why a script instead of an inline `npx camoufox-js fetch`:
//   1. Cross-platform: avoids POSIX-only `VAR= cmd` shell syntax (Windows
//      cmd.exe does not honor it).
//   2. Defends against PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 inherited from
//      the user's shell or a CI/Docker base image. `camoufox-js` honors
//      that flag by convention (same env name as `playwright`'s skip flag),
//      which leaves the binary cache empty and makes the server crash at
//      runtime with "Version information not found".
//   3. Verifies the cache after fetch and exits non-zero with actionable
//      remediation if the binary is still missing — failing the install
//      is strictly better than a silent runtime crash.

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir, platform } from 'node:os';
import { join } from 'node:path';

function camoufoxCacheDir() {
  const home = homedir();
  const plat = platform();
  if (plat === 'darwin') return join(home, 'Library', 'Caches', 'camoufox');
  if (plat === 'win32') {
    // Matches camoufox-js/dist/pkgman.js:246 which nests the app name twice:
    // %LOCALAPPDATA%\camoufox\camoufox\Cache
    const base = process.env.LOCALAPPDATA || join(home, 'AppData', 'Local');
    return join(base, 'camoufox', 'camoufox', 'Cache');
  }
  return join(process.env.XDG_CACHE_HOME || join(home, '.cache'), 'camoufox');
}

function fail(message) {
  process.stderr.write(`[camofox-browser] postinstall: ${message}\n`);
  process.exit(1);
}

const childEnv = { ...process.env };
delete childEnv.PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD;

const isWindows = platform() === 'win32';
const result = spawnSync(isWindows ? 'npx.cmd' : 'npx', ['camoufox-js', 'fetch'], {
  stdio: 'inherit',
  env: childEnv,
  shell: isWindows,
});

if (result.error) fail(`failed to spawn npx: ${result.error.message}`);
if (result.status !== 0) fail(`\`npx camoufox-js fetch\` exited with code ${result.status}`);

const versionFile = join(camoufoxCacheDir(), 'version.json');
if (!existsSync(versionFile)) {
  process.stderr.write('[camofox-browser] postinstall: Camoufox cache not populated.\n');
  process.stderr.write(`  Expected file: ${versionFile}\n`);
  process.stderr.write('  Possible causes:\n');
  process.stderr.write('    - Network failure during binary download (check your connection)\n');
  process.stderr.write('    - PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD re-exported by a wrapping process\n');
  process.stderr.write('  Manual fix:  PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD= npx camoufox-js fetch\n');
  process.exit(1);
}
