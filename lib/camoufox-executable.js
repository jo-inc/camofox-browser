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
  const macAppResources = platform() === 'darwin'
    ? [
        join(dirname(dirname(executablePath)), 'Resources'),
        join(dirname(dirname(resolvedPath)), 'Resources'),
      ]
    : [];

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

  const allCandidates = [...directDirs, ...macAppResources, ...likelyDirs];
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
  const resolvedTarget = realpathSync(target);
  try {
    symlinkSync(
      resolvedTarget,
      linkPath,
      platform() === 'win32' && type === 'dir' ? 'junction' : type,
    );
    return;
  } catch (err) {
    if (err?.code !== 'EEXIST') throw err;
  }

  let existingTarget;
  try {
    existingTarget = realpathSync(linkPath);
  } catch {
    throw new Error(`Existing cache path is not a valid symlink target: ${linkPath}`);
  }
  if (existingTarget !== resolvedTarget) {
    throw new Error(`Existing cache link points to an unexpected target: ${linkPath}`);
  }
}

function shimRootFor(executablePath, resourceDir) {
  const key = crypto
    .createHash('sha256')
    .update(`${realpathSync(executablePath)}\n${realpathSync(resourceDir)}`)
    .digest('hex')
    .slice(0, 16);
  return join(tmpdir(), 'camofox-browser-external-camoufox', key);
}

function isMacAppExecutable(executablePath) {
  return platform() === 'darwin' && /\.app\/Contents\/MacOS\/[^/]+$/.test(executablePath);
}

function ensureLaunchShim(executablePath, resourceDir) {
  // A macOS app executable resolves XPCOM and dylibs relative to its .app
  // bundle. Launching it through a flattened compatibility shim breaks that
  // lookup, so retain the original immutable bundle path.
  if (isMacAppExecutable(executablePath)) return executablePath;

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

  const versionFile = join(resourceDir, 'version.json');
  const propertiesFile = join(resourceDir, 'properties.json');
  const fontconfig = join(resourceDir, 'fontconfig');

  let versionBytes;
  let realPropertiesFile;
  let realFontconfig;
  try {
    versionBytes = readFileSync(versionFile);
    realPropertiesFile = realpathSync(propertiesFile);
    realFontconfig = realpathSync(fontconfig);
  } catch (err) {
    if (err?.code === 'ENOENT') {
      throw new Error(
        `External Camoufox bundle at ${resourceDir} must include properties.json, version.json, and fontconfig/ for camoufox-js compatibility`
      );
    }
    throw err;
  }

  mkdirSync(cacheDir, { recursive: true });
  try {
    writeFileSync(cacheVersion, versionBytes, { flag: 'wx', mode: 0o600 });
  } catch (err) {
    if (err?.code !== 'EEXIST') throw err;
    const existingVersion = readFileSync(cacheVersion);
    if (!existingVersion.equals(versionBytes)) {
      throw new Error(`Existing cache version does not match external Camoufox bundle: ${cacheVersion}`);
    }
  }
  ensureSymlink(realPropertiesFile, cacheProperties);
  ensureSymlink(realFontconfig, cacheFontconfig, 'dir');
  mkdirSync(dirname(cacheExecutable), { recursive: true });
  ensureSymlink(executablePath, cacheExecutable);
}

function ensureMacCamoufoxJsCompatibility(executablePath, resourceDir, cacheDir) {
  const bundleCacheDir = dirname(dirname(dirname(dirname(executablePath))));
  const bundledVersion = join(bundleCacheDir, 'version.json');
  const cacheVersion = join(cacheDir, 'version.json');
  const executableProperties = join(dirname(executablePath), 'properties.json');
  const resourceProperties = join(resourceDir, 'properties.json');
  if (!existsSync(cacheVersion)) {
    if (!existsSync(bundledVersion)) {
      throw new Error(`macOS external Camoufox bundle requires version.json beside its Camoufox.app: ${bundledVersion}`);
    }
    mkdirSync(cacheDir, { recursive: true });
    writeFileSync(cacheVersion, readFileSync(bundledVersion));
  }
  if (!existsSync(executableProperties)) ensureSymlink(realpathSync(resourceProperties), executableProperties);
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

  if (isMacAppExecutable(resolvedExecutable)) {
    ensureMacCamoufoxJsCompatibility(resolvedExecutable, resourceDir, cacheDir);
    return { executablePath: resolvedExecutable, resourceDir };
  }

  ensureCamoufoxJsCache(resourceDir, cacheDir, resolvedExecutable);

  return {
    executablePath: ensureLaunchShim(resolvedExecutable, resourceDir),
    resourceDir,
  };
}
