#!/usr/bin/env node
// Download Camoufox at installation time without spawning a shell or `npx`.
// Failures are warnings so restricted plugin-install environments can still
// install the JavaScript package and fetch the browser later.

import { accessSync, constants, existsSync, readFileSync, statSync } from 'node:fs';
import { homedir, platform } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { BUNDLED_CAMOUFOX_RELEASE, downloadBundledCamoufox } from './lib/camoufox-download.js';

const EXTERNAL_EXECUTABLE_ENV_VARS = [
  'CAMOUFOX_EXECUTABLE',
  'CAMOUFOX_EXECUTABLE_PATH',
  'CAMOFOX_EXECUTABLE_PATH',
];

function camoufoxCacheDir() {
  const home = homedir();
  const plat = platform();
  if (plat === 'darwin') return join(home, 'Library', 'Caches', 'camoufox');
  if (plat === 'win32') {
    const base = process.env.LOCALAPPDATA || join(home, 'AppData', 'Local');
    return join(base, 'camoufox', 'camoufox', 'Cache');
  }
  return join(process.env.XDG_CACHE_HOME || join(home, '.cache'), 'camoufox');
}

function warn(message) {
  process.stderr.write(`[camofox-browser] postinstall warning: ${message}\n`);
}

function fail(message) {
  warn(message);
  warn('The Camoufox browser binary may not have been downloaded.');
  warn('Run `npm run fetch-bin` manually before starting the server.');
  process.exit(0);
}

export function externalExecutableFromEnv(env = process.env) {
  for (const name of EXTERNAL_EXECUTABLE_ENV_VARS) {
    const value = (env[name] || '').trim();
    if (value) return { name, value };
  }
  return null;
}

function assertExternalExecutable(path) {
  if (!existsSync(path)) fail(`external Camoufox executable does not exist: ${path}`);
  const stat = statSync(path);
  if (!stat.isFile()) fail(`external Camoufox executable is not a file: ${path}`);
  if (platform() !== 'win32') {
    try {
      accessSync(path, constants.X_OK);
    } catch {
      fail(`external Camoufox executable is not executable: ${path}`);
    }
  }
}

// The release a Camoufox cache holds, as "<version>-<release>" like BUNDLED_CAMOUFOX_RELEASE,
// or null when its version.json is missing or unreadable.
export function cachedCamoufoxRelease(versionFile) {
  try {
    const { version, release } = JSON.parse(readFileSync(versionFile, 'utf8'));
    return version && release ? `${version}-${release}` : null;
  } catch {
    return null;
  }
}

export async function main({ download = downloadBundledCamoufox, cacheDir = camoufoxCacheDir() } = {}) {
  if (process.env.CAMOFOX_SKIP_DOWNLOAD === '1' || process.env.CAMOFOX_SKIP_DOWNLOAD === 'true') {
    process.stderr.write('[camofox-browser] postinstall: skipping binary download (CAMOFOX_SKIP_DOWNLOAD=1)\n');
    return;
  }

  const externalExecutable = externalExecutableFromEnv();
  if (externalExecutable) {
    assertExternalExecutable(externalExecutable.value);
    process.stdout.write(
      `[camofox-browser] postinstall: ${externalExecutable.name} is set; skipping bundled Camoufox download.\n`
    );
    return;
  }

  // Compare, not just look: a cache from an earlier install (or another tool sharing it) can
  // hold a release other than the one this version pins, and nothing else replaces it.
  const versionFile = join(cacheDir, 'version.json');
  const cached = cachedCamoufoxRelease(versionFile);
  if (cached === BUNDLED_CAMOUFOX_RELEASE) {
    process.stdout.write('[camofox-browser] postinstall: Camoufox binary already cached.\n');
    return;
  }
  if (cached) {
    process.stdout.write(
      `[camofox-browser] postinstall: cached Camoufox ${cached} is not the pinned ${BUNDLED_CAMOUFOX_RELEASE}; fetching it.\n`
    );
  }

  try {
    await download();
  } catch (error) {
    fail(`failed to download Camoufox: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!existsSync(versionFile)) {
    warn('Camoufox cache not populated after fetch.');
    warn(`  Expected file: ${versionFile}`);
    warn('  Manual fix: npm run fetch-bin');
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(() => process.exit(0));
}
