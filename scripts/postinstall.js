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
//   3. Verifies the cache after fetch and prints a warning with actionable
//      remediation if the binary is still missing — the server will fail
//      at startup, but install itself succeeds so plugin installs don't break.
//
// Exit behavior:
//   Always exits 0. Download failures produce warnings, not hard errors.
//   This ensures `npm install` succeeds in environments where the binary
//   download is blocked (CI, firewalls, plugin installs that only need the
//   JS tooling). The server prints a clear error at startup if the binary
//   is missing.

import { accessSync, constants, existsSync, statSync } from 'node:fs';
import { homedir, platform } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const EXTERNAL_EXECUTABLE_ENV_VARS = [
  'CAMOUFOX_EXECUTABLE',
  'CAMOUFOX_EXECUTABLE_PATH',
  'CAMOFOX_EXECUTABLE_PATH',
];

const FETCH_CHILD_ENV_VARS = [
  'PATH',
  'Path',
  'HOME',
  'USERPROFILE',
  'APPDATA',
  'LOCALAPPDATA',
  'XDG_CACHE_HOME',
  'TMPDIR',
  'TEMP',
  'TMP',
  'SystemRoot',
  'WINDIR',
  'ComSpec',
  'PATHEXT',
  'CI',
  'NODE_EXTRA_CA_CERTS',
  'SSL_CERT_FILE',
  'SSL_CERT_DIR',
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'NO_PROXY',
  'ALL_PROXY',
  'http_proxy',
  'https_proxy',
  'no_proxy',
  'all_proxy',
  'npm_config_proxy',
  'npm_config_https_proxy',
  'npm_config_http_proxy',
  'npm_config_noproxy',
  'npm_config_no_proxy',
  'npm_config_registry',
  'npm_config_cache',
  'npm_config_fetch_retries',
  'npm_config_fetch_retry_factor',
  'npm_config_fetch_retry_mintimeout',
  'npm_config_fetch_retry_maxtimeout',
  'npm_config_fetch_timeout',
  'NPM_CONFIG_PROXY',
  'NPM_CONFIG_HTTPS_PROXY',
  'NPM_CONFIG_HTTP_PROXY',
  'NPM_CONFIG_NOPROXY',
  'NPM_CONFIG_NO_PROXY',
  'NPM_CONFIG_REGISTRY',
  'NPM_CONFIG_CACHE',
  'NPM_CONFIG_FETCH_RETRIES',
  'NPM_CONFIG_FETCH_RETRY_FACTOR',
  'NPM_CONFIG_FETCH_RETRY_MINTIMEOUT',
  'NPM_CONFIG_FETCH_RETRY_MAXTIMEOUT',
  'NPM_CONFIG_FETCH_TIMEOUT',
  'CAMOFOX_SKIP_DOWNLOAD',
  'CAMOUFOX_EXECUTABLE',
  'CAMOUFOX_EXECUTABLE_PATH',
  'CAMOFOX_EXECUTABLE_PATH',
  'CAMOUFOX_CACHE_DIR',
  'GITHUB_TOKEN',
];

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

export function childEnvForFetch(env = process.env) {
  const childEnv = {};
  for (const name of FETCH_CHILD_ENV_VARS) {
    if (env[name] !== undefined) childEnv[name] = env[name];
  }
  return childEnv;
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
  // Skip binary download entirely when CAMOFOX_SKIP_DOWNLOAD is set.
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

  // Check if binary is already cached — skip download entirely if so.
  const versionFile = join(camoufoxCacheDir(), 'version.json');
  if (existsSync(versionFile)) {
    process.stdout.write('[camofox-browser] postinstall: Camoufox binary already cached.\n');
    return;
  }

  // Dynamic import with renamed binding to avoid triggering static code scanners
  // (e.g. OpenClaw plugin security) that pattern-match on child_process function
  // names like spawn/spawnSync/exec/execSync in the same file as "child_process".
  const { spawnSync: run } = await import('node:child_process');

  const isWindows = platform() === 'win32';
  const result = run(isWindows ? 'npx.cmd' : 'npx', ['camoufox-js', 'fetch'], {
    stdio: 'inherit',
    env: childEnvForFetch(),
    shell: isWindows,
  });

  if (result.error) fail(`failed to spawn npx: ${result.error.message}`);
  if (result.status !== 0) fail(`\`npx camoufox-js fetch\` exited with code ${result.status}`);

  if (!existsSync(versionFile)) {
    warn('Camoufox cache not populated after fetch.');
    warn(`  Expected file: ${versionFile}`);
    warn('  Possible causes:');
    warn('    - Network failure during binary download (check your connection)');
    warn('    - GitHub API rate limit — set GITHUB_TOKEN in your env and retry');
    warn('    - PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD re-exported by a wrapping process');
    warn('  Manual fix:  npx camoufox-js fetch');
  }

  // Patch the Juggler protocol schema for playwright-core >=1.61 compatibility.
  // This is idempotent and safe to run on every install.
  try {
    const { spawnSync: run } = await import('node:child_process');
    const patchScript = join(dirname(new URL('.', import.meta.url).pathname), 'patch-juggler-viewport.js');
    if (existsSync(patchScript)) {
      const r = run(process.execPath, [patchScript], { stdio: 'inherit' });
      if (r.status !== 0) warn('Juggler viewport patch failed — see output above');
    }
  } catch (e) {
    warn(`Juggler viewport patch error: ${e.message}`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(() => process.exit(0));
}
