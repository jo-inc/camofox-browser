import {
  accessSync,
  constants,
  existsSync,
  readdirSync,
  realpathSync,
  statSync,
} from 'fs';
import { basename, dirname, join, resolve } from 'path';
import { platform } from 'os';

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

function isMacAppExecutable(executablePath) {
  return platform() === 'darwin' && /\.app\/Contents\/MacOS\/[^/]+$/.test(executablePath);
}

// Where the official camoufox package looks for the files a build ships
// (properties.json, application.ini, addons/): beside the executable, or in
// Contents/Resources when the executable sits in a macOS app's Contents/MacOS.
function bundleFileDir(executablePath) {
  const directory = dirname(executablePath);
  return basename(directory) === 'MacOS' ? join(dirname(directory), 'Resources') : directory;
}

// The official camoufox package reads the build's files relative to the path
// it launches, so the executable is launched in place rather than through a
// cache of links. Prefer the configured path, then its symlink target.
function inPlaceExecutable(executablePath, resourceDir) {
  const candidates = [executablePath, realpathSync(executablePath)];
  return candidates.find(candidate => realpathSync(bundleFileDir(candidate)) === realpathSync(resourceDir))
    || null;
}

export function prepareExternalCamoufoxExecutable(executablePath) {
  if (!executablePath) return null;

  const resolvedExecutable = resolve(executablePath);
  assertExecutable(resolvedExecutable);

  const resourceDir = findResourceDir(resolvedExecutable);
  if (!resourceDir) {
    throw new Error(
      `Could not find Camoufox resources for ${resolvedExecutable}. ` +
      'Point the executable override at a Camoufox bundle that includes properties.json.'
    );
  }

  const launchExecutable = inPlaceExecutable(resolvedExecutable, resourceDir);
  if (!launchExecutable) {
    throw new Error(
      `Camoufox resources for ${resolvedExecutable} are in ${resourceDir}, not beside the executable. ` +
      'Point the executable override at the Camoufox binary inside that bundle.'
    );
  }

  if (!isMacAppExecutable(launchExecutable)) {
    for (const name of ['properties.json', 'version.json', 'fontconfig']) {
      if (!existsSync(join(resourceDir, name))) {
        throw new Error(
          `External Camoufox bundle at ${resourceDir} must include properties.json, version.json, and fontconfig/`
        );
      }
    }
  }

  return { executablePath: launchExecutable, resourceDir };
}
