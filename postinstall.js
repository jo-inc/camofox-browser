#!/usr/bin/env node
// Download Camoufox at installation time without spawning a shell or `npx`.
// Failures are warnings so restricted plugin-install environments can still
// install the JavaScript package and fetch the browser later.

import { accessSync, constants, existsSync, statSync } from 'node:fs';
import { homedir, platform } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { downloadBundledCamoufox } from './lib/camoufox-download.js';

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
  warn('Run `npx camoufox-js fetch` manually before starting the server.');
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

export async function main() {
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

  const versionFile = join(camoufoxCacheDir(), 'version.json');
  if (existsSync(versionFile)) {
    process.stdout.write('[camofox-browser] postinstall: Camoufox binary already cached.\n');
    return;
  }

  try {
    await downloadBundledCamoufox();
  } catch (error) {
    fail(`failed to download Camoufox: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!existsSync(versionFile)) {
    warn('Camoufox cache not populated after fetch.');
    warn(`  Expected file: ${versionFile}`);
    warn('  Manual fix: npx camoufox-js fetch');
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(() => process.exit(0));
}
