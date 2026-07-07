#!/usr/bin/env node
// Patch the Camoufox Juggler protocol schema to accept isMobile and screenSize
// fields that playwright-core >=1.61 sends in Browser.setDefaultViewport and
// Page.setViewportSize. Without this patch, Playwright 1.61+ fails every
// context creation and viewport resize with a protocol schema validation error.
//
// See: https://github.com/daijro/camoufox/issues/653
//
// This script patches chrome/juggler/content/protocol/Protocol.js inside
// the Camoufox omni.ja archive. The Juggler handlers already ignore the
// extra fields — only the schema validator (checkScheme in PrimitiveTypes.js)
// rejects them.
//
// Usage:
//   node scripts/patch-juggler-viewport.js
//
// Exit codes:
//   0 — patch applied (or already applied)
//   1 — Camoufox not found or patch failed

import { existsSync, readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { homedir, platform } from 'node:os';
import { execSync } from 'node:child_process';

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

const PROTOCOL_PATH = 'chrome/juggler/content/protocol/Protocol.js';

// Patches to apply:
const PATCHES = [
  {
    name: 'pageTypes.Viewport',
    find: `pageTypes.Viewport = {
  viewportSize: pageTypes.Size,
  deviceScaleFactor: t.Optional(t.Number),
};`,
    replace: `pageTypes.Viewport = {
  viewportSize: pageTypes.Size,
  screenSize: t.Optional(pageTypes.Size),
  deviceScaleFactor: t.Optional(t.Number),
  isMobile: t.Optional(t.Boolean),
};`,
  },
  {
    name: 'Page.setViewportSize params',
    find: `    'setViewportSize': {
      params: {
        viewportSize: t.Nullable(pageTypes.Size),
      },
    },`,
    replace: `    'setViewportSize': {
      params: {
        viewportSize: t.Nullable(pageTypes.Size),
        screenSize: t.Optional(pageTypes.Size),
        isMobile: t.Optional(t.Boolean),
      },
    },`,
  },
];

function main() {
  const cacheDir = camoufoxCacheDir();
  const omniJa = join(cacheDir, 'omni.ja');

  if (!existsSync(omniJa)) {
    process.stderr.write(`[patch-juggler] omni.ja not found at ${omniJa}\n`);
    process.stderr.write('[patch-juggler] Run `npx camoufox-js fetch` first.\n');
    process.exit(1);
  }

  // Extract Protocol.js from omni.ja
  const tmpDir = join(cacheDir, '.juggler-patch-tmp');
  rmSync(tmpDir, { recursive: true, force: true });
  mkdirSync(tmpDir, { recursive: true });

  try {
    execSync(`unzip -o "${omniJa}" "${PROTOCOL_PATH}" -d "${tmpDir}"`, { stdio: 'pipe' });
  } catch {
    process.stderr.write(`[patch-juggler] Failed to extract ${PROTOCOL_PATH} from omni.ja\n`);
    process.exit(1);
  }

  const protocolFile = join(tmpDir, PROTOCOL_PATH);
  if (!existsSync(protocolFile)) {
    process.stderr.write(`[patch-juggler] ${PROTOCOL_PATH} not found in omni.ja\n`);
    process.exit(1);
  }

  let content = readFileSync(protocolFile, 'utf8');
  let patched = 0;

  for (const patch of PATCHES) {
    if (content.includes(patch.replace)) {
      // Already patched
      process.stdout.write(`[patch-juggler] ${patch.name}: already patched\n`);
      patched++;
      continue;
    }
    if (!content.includes(patch.find)) {
      process.stderr.write(`[patch-juggler] ${patch.name}: pattern not found — schema may have changed\n`);
      continue;
    }
    content = content.replace(patch.find, patch.replace);
    process.stdout.write(`[patch-juggler] ${patch.name}: patched\n`);
    patched++;
  }

  if (patched === 0) {
    process.stderr.write('[patch-juggler] No patches applied — aborting\n');
    process.exit(1);
  }

  // Check if all patches were already applied
  if (patched === PATCHES.length && !PATCHES.some(p => content.includes(p.find))) {
    process.stdout.write('[patch-juggler] All patches already in place — omni.ja unchanged\n');
    rmSync(tmpDir, { recursive: true, force: true });
    process.exit(0);
  }

  // Write patched Protocol.js back
  writeFileSync(protocolFile, content, 'utf8');

  // Repack omni.ja with patched Protocol.js using Python zipfile
  const pythonScript = `
import zipfile, shutil, os, sys
src = '${omniJa}'
tmp = src + '.tmp'
patched_file = '${protocolFile}'
target = '${PROTOCOL_PATH}'

with zipfile.ZipFile(src, 'r') as zin:
    with zipfile.ZipFile(tmp, 'w', zipfile.ZIP_DEFLATED) as zout:
        for item in zin.infolist():
            if item.filename == target:
                zout.writestr(item, open(patched_file, 'rb').read())
            else:
                zout.writestr(item, zin.read(item.filename))

shutil.move(tmp, src)
print('[patch-juggler] omni.ja repacked successfully')
`;

  try {
    execSync(`python3 -c '${pythonScript.replace(/'/g, "'\\''")}'`, { stdio: 'inherit' });
  } catch {
    process.stderr.write('[patch-juggler] Failed to repack omni.ja\n');
    process.exit(1);
  }

  // Cleanup
  rmSync(tmpDir, { recursive: true, force: true });
  process.stdout.write('[patch-juggler] Done. Camoufox Juggler protocol patched for playwright-core >=1.61.\n');
}

main();