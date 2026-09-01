import fs from 'fs';
import path from 'path';
import os from 'os';

const ORPHAN_PATTERNS = [
  /^\.fea5[a-f0-9]+\.so$/,
  /^\.5ef7[a-f0-9]+\.node$/,
];

// Firefox temp profile directories created by Playwright/Camoufox
const FIREFOX_PROFILE_PATTERN = /^playwright_firefoxdev_profile-/;
// Camoufox also creates these
const CAMOUFOX_TMP_PATTERN = /^camoufox[-_]/;

export function removeXvfbDisplayFiles(display, {
  socketDir = path.join(os.tmpdir(), '.X11-unix'),
  lockDir = os.tmpdir(),
} = {}) {
  const displayNum = Number(display);
  if (!Number.isSafeInteger(displayNum) || displayNum < 0 || String(displayNum) !== String(display)) return;

  for (const file of [path.join(socketDir, `X${displayNum}`), path.join(lockDir, `.X${displayNum}-lock`)]) {
    try {
      fs.unlinkSync(file);
    } catch {
      // File already removed, unavailable, or belongs to a filesystem that cannot unlink it.
    }
  }
}

export function cleanupOrphanedTempFiles({ tmpDir, minAgeMs = 5 * 60 * 1000, now = Date.now() } = {}) {
  const result = { scanned: 0, removed: 0, bytes: 0, skipped: 0 };
  if (!tmpDir) return result;

  let entries;
  try {
    entries = fs.readdirSync(tmpDir);
  } catch {
    return result;
  }

  for (const name of entries) {
    if (!ORPHAN_PATTERNS.some((re) => re.test(name))) continue;
    result.scanned++;
    const full = path.join(tmpDir, name);
    try {
      const st = fs.statSync(full);
      if (!st.isFile()) continue;
      if (now - st.mtimeMs < minAgeMs) {
        result.skipped++;
        continue;
      }
      fs.unlinkSync(full);
      result.removed++;
      result.bytes += st.size;
    } catch {
      // file vanished, permission denied, or race with another process - skip silently
    }
  }

  return result;
}

/**
 * Clean up stale Firefox/Camoufox temp profile directories.
 * These accumulate when browser.close() doesn't fully clean up
 * (especially with enable_cache: true). Each profile can be 10-100MB+.
 *
 * Only removes profiles older than minAgeMs (default 2 minutes)
 * to avoid killing profiles belonging to an actively launching browser.
 */
export function cleanupStaleFirefoxProfiles({ tmpDir, minAgeMs = 2 * 60 * 1000, now = Date.now() } = {}) {
  const dir = tmpDir || os.tmpdir();
  const result = { scanned: 0, removed: 0, bytes: 0, skipped: 0 };

  let entries;
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return result;
  }

  for (const name of entries) {
    if (!FIREFOX_PROFILE_PATTERN.test(name) && !CAMOUFOX_TMP_PATTERN.test(name)) continue;
    result.scanned++;
    const full = path.join(dir, name);
    try {
      const st = fs.statSync(full);
      if (!st.isDirectory()) continue;
      if (now - st.mtimeMs < minAgeMs) {
        result.skipped++;
        continue;
      }
      // Calculate directory size before removing
      const dirBytes = _dirSizeSync(full);
      fs.rmSync(full, { recursive: true, force: true, maxRetries: 3 });
      result.removed++;
      result.bytes += dirBytes;
    } catch {
      // directory vanished, permission denied, or in-use -- skip
    }
  }

  return result;
}

/** Recursively calculate directory size (best effort, fast). */
function _dirSizeSync(dirPath) {
  let total = 0;
  try {
    const entries = fs.readdirSync(dirPath, { withFileTypes: true });
    for (const entry of entries) {
      const full = path.join(dirPath, entry.name);
      try {
        if (entry.isDirectory()) {
          total += _dirSizeSync(full);
        } else {
          total += fs.statSync(full).size;
        }
      } catch { /* skip */ }
    }
  } catch { /* skip */ }
  return total;
}
