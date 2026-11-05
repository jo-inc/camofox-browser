import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { decryptJson, encryptJson } from './storage-crypto.js';

/**
 * Saved browser sessions, encrypted at rest.
 *
 * Each file is written with AES-256-GCM (see lib/storage-crypto.js). Without
 * a storage key nothing is written and nothing is loaded, so a session never
 * sits on disk in plain text. Saved state is handed back to Playwright as an
 * object, not as a file path, so decrypted data never has to touch disk.
 *
 * Logs record paths and error messages only, never cookie or storage values.
 */

function getUserPersistencePaths(profileDir, userId) {
  const rootDir = path.resolve(profileDir);
  const safeUserDir = crypto
    .createHash('sha256')
    .update(String(userId))
    .digest('hex')
    .slice(0, 32);

  const userDir = path.join(rootDir, safeUserDir);
  return {
    rootDir,
    userDir,
    storageStatePath: path.join(userDir, 'storage-state.enc'),
    metaPath: path.join(userDir, 'meta.json'),
  };
}

function isStorageStateShape(value) {
  if (!value || typeof value !== 'object') return false;
  if (!Array.isArray(value.cookies)) return false;
  if (value.origins !== undefined && !Array.isArray(value.origins)) return false;
  return true;
}

/**
 * Returns the saved storage state as an object, or undefined when there is
 * none, no key is configured, or the file cannot be decrypted.
 */
async function loadPersistedStorageState(profileDir, userId, logger = console, storageKey = null) {
  if (!profileDir || !storageKey) return undefined;

  const { storageStatePath } = getUserPersistencePaths(profileDir, userId);

  try {
    const raw = await fs.readFile(storageStatePath);
    const parsed = decryptJson(storageKey, raw);
    if (!isStorageStateShape(parsed)) return undefined;
    return parsed;
  } catch (err) {
    if (err?.code === 'ENOENT') return undefined;
    logger?.warn?.('failed to load persisted storage state', {
      userId: String(userId),
      storageStatePath,
      error: err?.message || String(err),
    });
    return undefined;
  }
}

async function persistStorageState({
  profileDir,
  userId,
  context,
  storageState,
  logger = console,
  indexedDB = false,
  storageKey = null,
}) {
  if (!profileDir || (!context && !storageState)) {
    return { persisted: false, reason: 'disabled' };
  }
  if (!storageKey) {
    return { persisted: false, reason: 'no_storage_key' };
  }

  const { userDir, storageStatePath, metaPath } = getUserPersistencePaths(profileDir, userId);
  const suffix = `.tmp-${process.pid}-${Date.now()}`;
  const tmpStoragePath = `${storageStatePath}${suffix}`;
  const tmpMetaPath = `${metaPath}${suffix}`;

  try {
    await fs.mkdir(userDir, { recursive: true, mode: 0o700 });
    const state = storageState
      ?? await context.storageState(indexedDB ? { indexedDB: true } : undefined);
    if (!isStorageStateShape(state)) {
      throw new Error('storage state has an unexpected shape');
    }
    await fs.writeFile(tmpStoragePath, encryptJson(storageKey, state), { mode: 0o600 });
    await fs.rename(tmpStoragePath, storageStatePath);
    await fs.writeFile(
      tmpMetaPath,
      JSON.stringify(
        {
          userId: String(userId),
          updatedAt: new Date().toISOString(),
          format: 'aes-256-gcm',
        },
        null,
        2
      ),
      { mode: 0o600 }
    );
    await fs.rename(tmpMetaPath, metaPath);
    return { persisted: true, userDir, storageStatePath, metaPath };
  } catch (err) {
    await fs.unlink(tmpStoragePath).catch(() => {});
    await fs.unlink(tmpMetaPath).catch(() => {});
    logger?.warn?.('failed to persist storage state', {
      userId: String(userId),
      storageStatePath,
      error: err?.message || String(err),
    });
    return { persisted: false, reason: 'error', error: err };
  }
}

export {
  getUserPersistencePaths,
  loadPersistedStorageState,
  persistStorageState,
};
