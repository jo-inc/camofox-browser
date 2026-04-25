import fs from 'fs';
import fsp from 'fs/promises';
import path from 'path';
import crypto from 'crypto';

function hashUserId(userId) {
  return crypto.createHash('sha256').update(String(userId)).digest('hex').slice(0, 16);
}

export function userTracesDir(baseDir, userId) {
  return path.join(baseDir, hashUserId(userId));
}

export function ensureTracesDir(baseDir, userId) {
  const dir = userTracesDir(baseDir, userId);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function makeTraceFilename() {
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const suffix = crypto.randomBytes(3).toString('hex');
  return `trace-${ts}-${suffix}.zip`;
}

export function tracePathFor(baseDir, userId, filename) {
  return path.join(ensureTracesDir(baseDir, userId), filename);
}

export function resolveTracePath(baseDir, userId, filename) {
  if (!filename || filename.includes('/') || filename.includes('\\') || filename.includes('..') || filename.startsWith('.')) {
    return null;
  }
  const userDir = userTracesDir(baseDir, userId);
  const full = path.join(userDir, filename);
  const resolved = path.resolve(full);
  if (!resolved.startsWith(path.resolve(userDir) + path.sep)) return null;
  return resolved;
}

export async function listUserTraces(baseDir, userId) {
  const dir = userTracesDir(baseDir, userId);
  let names;
  try {
    names = await fsp.readdir(dir);
  } catch {
    return [];
  }
  const out = [];
  for (const name of names) {
    if (!name.endsWith('.zip')) continue;
    const full = path.join(dir, name);
    try {
      const st = await fsp.stat(full);
      if (!st.isFile()) continue;
      out.push({
        filename: name,
        sizeBytes: st.size,
        createdAt: st.birthtimeMs || st.ctimeMs,
        modifiedAt: st.mtimeMs,
      });
    } catch {
      // vanished mid-scan
    }
  }
  out.sort((a, b) => b.modifiedAt - a.modifiedAt);
  return out;
}

export async function statTrace(fullPath) {
  try {
    const st = await fsp.stat(fullPath);
    if (!st.isFile()) return null;
    return st;
  } catch {
    return null;
  }
}

export async function deleteTrace(fullPath) {
  await fsp.unlink(fullPath);
}

export function sweepOldTraces({ baseDir, ttlMs, maxBytesPerFile, now = Date.now() } = {}) {
  const result = { scanned: 0, removedTtl: 0, removedOversized: 0, bytes: 0 };
  if (!baseDir) return result;

  let userDirs;
  try {
    userDirs = fs.readdirSync(baseDir);
  } catch {
    return result;
  }

  for (const userDir of userDirs) {
    const dir = path.join(baseDir, userDir);
    let st;
    try {
      st = fs.statSync(dir);
    } catch {
      continue;
    }
    if (!st.isDirectory()) continue;

    let files;
    try {
      files = fs.readdirSync(dir);
    } catch {
      continue;
    }

    for (const name of files) {
      if (!name.endsWith('.zip')) continue;
      result.scanned++;
      const full = path.join(dir, name);
      try {
        const fst = fs.statSync(full);
        if (!fst.isFile()) continue;
        const tooOld = ttlMs && (now - fst.mtimeMs) > ttlMs;
        const tooBig = maxBytesPerFile && fst.size > maxBytesPerFile;
        if (tooOld) {
          fs.unlinkSync(full);
          result.removedTtl++;
          result.bytes += fst.size;
        } else if (tooBig) {
          fs.unlinkSync(full);
          result.removedOversized++;
          result.bytes += fst.size;
        }
      } catch {
        // vanished or permission denied
      }
    }
  }

  return result;
}
