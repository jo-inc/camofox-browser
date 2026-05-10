import crypto from 'crypto';
import {
  accessSync,
  constants,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'fs';
import { dirname, join, resolve } from 'path';
import { platform, tmpdir } from 'os';

function assertExecutable(path) {
  const stat = statSync(path);
  if (!stat.isFile() && !stat.isSymbolicLink()) {
    throw new Error(`Camoufox executable is not a file: ${path}`);
  }
  if (platform() !== 'win32') accessSync(path, constants.X_OK);
}

function nixStoreRoot(path) {
  const match = path.match(/^\/nix\/store\/[^/]+/);
  return match?.[0] || null;
}

function collectDirs(root, maxDepth = 4) {
  const dirs = [];
  const queue = [{ dir: root, depth: 0 }];
  const seen = new Set();

  while (queue.length > 0) {
    const { dir, depth } = queue.shift();
    if (seen.has(dir)) continue;
    seen.add(dir);
    dirs.push(dir);
    if (depth >= maxDepth) continue;

    let entries = [];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
      queue.push({ dir: join(dir, entry.name), depth: depth + 1 });
    }
  }

  return dirs;
}

function findResourceDir(executablePath) {
  const resolvedPath = realpathSync(executablePath);
  const directDirs = [
    dirname(executablePath),
    dirname(resolvedPath),
  ];

  const storeRoot = nixStoreRoot(resolvedPath) || nixStoreRoot(executablePath);
  const likelyDirs = storeRoot
    ? [
        storeRoot,
        join(storeRoot, 'lib', 'camoufox'),
        join(storeRoot, 'libexec', 'camoufox'),
        join(storeRoot, 'share', 'camoufox'),
        join(storeRoot, 'opt', 'camoufox'),
      ]
    : [];

  const allCandidates = [...directDirs, ...likelyDirs];
  for (const dir of allCandidates) {
    if (existsSync(join(dir, 'properties.json'))) return dir;
  }

  if (storeRoot) {
    for (const dir of collectDirs(storeRoot)) {
      if (existsSync(join(dir, 'properties.json'))) return dir;
    }
  }

  return null;
}

function ensureSymlink(target, linkPath, type = 'file') {
  rmSync(linkPath, { force: true, recursive: true });
  symlinkSync(target, linkPath, platform() === 'win32' && type === 'dir' ? 'junction' : type);
}

function shimRootFor(executablePath, resourceDir) {
  const key = crypto
    .createHash('sha256')
    .update(`${realpathSync(executablePath)}\n${realpathSync(resourceDir)}`)
    .digest('hex')
    .slice(0, 16);
  return join(tmpdir(), 'camofox-browser-external-camoufox', key);
}

function ensureLaunchShim(executablePath, resourceDir) {
  const shimRoot = shimRootFor(executablePath, resourceDir);
  mkdirSync(shimRoot, { recursive: true });

  const shimExecutable = join(shimRoot, platform() === 'win32' ? 'camoufox.exe' : 'camoufox-bin');
  ensureSymlink(realpathSync(executablePath), shimExecutable);

  for (const name of ['properties.json', 'version.json']) {
    const target = join(resourceDir, name);
    if (existsSync(target)) ensureSymlink(realpathSync(target), join(shimRoot, name));
  }

  const fontconfig = join(resourceDir, 'fontconfig');
  if (existsSync(fontconfig)) ensureSymlink(realpathSync(fontconfig), join(shimRoot, 'fontconfig'), 'dir');

  return shimExecutable;
}

function camoufoxLaunchFileName() {
  if (platform() === 'win32') return 'camoufox.exe';
  if (platform() === 'darwin') return join('Camoufox.app', 'Contents', 'MacOS', 'camoufox');
  return 'camoufox-bin';
}

function ensureCamoufoxJsCache(resourceDir, cacheDir, executablePath) {
  const cacheVersion = join(cacheDir, 'version.json');
  const cacheFontconfig = join(cacheDir, 'fontconfig');
  const cacheProperties = join(cacheDir, 'properties.json');
  const cacheExecutable = join(cacheDir, camoufoxLaunchFileName());

  if (
    existsSync(cacheVersion) &&
    existsSync(cacheFontconfig) &&
    existsSync(cacheProperties) &&
    existsSync(cacheExecutable)
  ) {
    return;
  }

  const versionFile = join(resourceDir, 'version.json');
  const propertiesFile = join(resourceDir, 'properties.json');
  const fontconfig = join(resourceDir, 'fontconfig');
  if (!existsSync(versionFile) || !existsSync(propertiesFile) || !existsSync(fontconfig)) {
    throw new Error(
      `External Camoufox bundle at ${resourceDir} must include properties.json, version.json, and fontconfig/ for camoufox-js compatibility`
    );
  }

  mkdirSync(cacheDir, { recursive: true });
  if (!existsSync(cacheVersion)) {
    writeFileSync(cacheVersion, readFileSync(versionFile));
  }
  if (!existsSync(cacheProperties)) {
    ensureSymlink(realpathSync(propertiesFile), cacheProperties);
  }
  if (!existsSync(cacheFontconfig)) {
    ensureSymlink(realpathSync(fontconfig), cacheFontconfig, 'dir');
  }
  if (!existsSync(cacheExecutable)) {
    mkdirSync(dirname(cacheExecutable), { recursive: true });
    ensureSymlink(realpathSync(executablePath), cacheExecutable);
  }
}

export function prepareExternalCamoufoxExecutable(executablePath, { cacheDir } = {}) {
  if (!executablePath) return null;
  if (!cacheDir) throw new Error('cacheDir is required for external Camoufox executable preparation');

  const resolvedExecutable = resolve(executablePath);
  assertExecutable(resolvedExecutable);

  const resourceDir = findResourceDir(resolvedExecutable);
  if (!resourceDir) {
    throw new Error(
      `Could not find Camoufox resources for ${resolvedExecutable}. ` +
      'Point the executable override at a Camoufox bundle that includes properties.json.'
    );
  }

  ensureCamoufoxJsCache(resourceDir, cacheDir, resolvedExecutable);

  return {
    executablePath: ensureLaunchShim(resolvedExecutable, resourceDir),
    resourceDir,
  };
}
