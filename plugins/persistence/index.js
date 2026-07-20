/**
 * Persistence plugin for camofox-browser.
 *
 * Saves and restores per-user browser storage state (cookies + localStorage
 * + IndexedDB) across session restarts using Playwright's storageState API.
 *
 * Configuration (camofox.config.json):
 *   {
 *     "plugins": {
 *       "persistence": {
 *         "enabled": true,
 *         "profileDir": "/data/profiles",
 *         "indexedDB": true
 *       }
 *     }
 *   }
 *
 * The profile directory can also be set via environment variable:
 *   CAMOFOX_PROFILE_DIR=/data/profiles
 *
 * Each userId gets a deterministic SHA256-hashed subdirectory under profileDir.
 * Storage state is checkpointed on cookie import, session close, and shutdown.
 * On session creation, saved state is restored into the new Playwright context
 * via the session:creating hook (mutates contextOptions.storageState).
 *
 * indexedDB (default: false): opt in to capturing all serializable IndexedDB
 * records in storageState(). This can preserve IndexedDB-backed logins, but
 * may make snapshots significantly larger and checkpoints slower.
 */

import fs from 'node:fs/promises';
import {
  getUserPersistencePaths,
  loadPersistedStorageState,
  persistStorageState,
} from '../../lib/persistence.js';
import { importBootstrapCookies } from '../../lib/cookies.js';

async function removeIfExists(p) {
  try {
    await fs.unlink(p);
    return true;
  } catch (err) {
    if (err?.code === 'ENOENT') return false;
    throw err;
  }
}

export async function register(app, ctx, pluginConfig = {}) {
  const { events, config, log } = ctx;

  // Resolve profileDir: env var > plugin config > global config default (~/.camofox/profiles)
  const profileDir = process.env.CAMOFOX_PROFILE_DIR || pluginConfig.profileDir || config.profileDir;
  if (!profileDir) {
    log('warn', 'persistence plugin: no profileDir configured, plugin disabled');
    return;
  }

  // IndexedDB capture is opt-in because it may persist large amounts of
  // application data and make checkpoints significantly slower.
  const indexedDB = pluginConfig.indexedDB === true;
  ctx.persistenceStorageStateOptions = indexedDB ? { indexedDB: true } : undefined;

  const logger = {
    warn: (msg, fields = {}) => log('warn', msg, fields),
  };

  log('info', 'persistence plugin enabled', { profileDir, indexedDB });

  // Track active sessions for checkpoint on close
  const activeSessions = new Map(); // userId -> context

  /**
   * Checkpoint storage state to disk for a userId.
   */
  async function checkpoint(userId, context, reason, storageState) {
    if (!context && !storageState) return;
    const result = await persistStorageState({
      profileDir,
      userId,
      context,
      storageState,
      logger,
      indexedDB,
    });
    if (result.persisted) {
      log('info', 'storage state persisted', { userId, reason, path: result.storageStatePath });
    }
    return result;
  }

  // --- Lifecycle hooks ---

  // Before session context is created: inject storageState if we have one saved
  events.on('session:creating', async ({ userId, contextOptions }) => {
    const storageStatePath = await loadPersistedStorageState(profileDir, userId, logger);
    if (storageStatePath) {
      contextOptions.storageState = storageStatePath;
      log('info', 'restoring persisted storage state', { userId, storageStatePath });
    }
  });

  // After session is created: import bootstrap cookies if no persisted state,
  // and track the context for later checkpointing
  events.on('session:created', async ({ userId, context }) => {
    activeSessions.set(userId, context);

    // If no persisted state was restored, try bootstrap cookies
    const existingState = await loadPersistedStorageState(profileDir, userId, logger);
    if (!existingState) {
      const result = await importBootstrapCookies({
        cookiesDir: config.cookiesDir,
        context,
        logger,
      });
      if (result.imported > 0) {
        log('info', 'bootstrap cookies imported', { userId, count: result.imported, source: result.source });
        await checkpoint(userId, context, 'bootstrap_cookies');
      }
    }
  });

  // On cookie import: checkpoint
  events.on('session:cookies:import', async ({ userId }) => {
    const context = activeSessions.get(userId);
    if (context) {
      await checkpoint(userId, context, 'cookie_import');
    }
  });

  // When another plugin exports storage state, persist that exact snapshot so
  // the browser is serialized only once and the exported/checkpointed data match.
  events.on('session:storage:export', async ({ userId, storageState }) => {
    if (storageState) {
      await checkpoint(userId, undefined, 'storage_export', storageState);
    }
  });

  // On session destroying (pre-close): checkpoint while context is still alive
  events.on('session:destroying', async ({ userId, reason }) => {
    const context = activeSessions.get(userId);
    if (context) {
      await checkpoint(userId, context, reason).catch(() => {});
      activeSessions.delete(userId);
    }
  });

  // On session destroyed (post-close): cleanup tracking if not already done
  events.on('session:destroyed', async ({ userId }) => {
    activeSessions.delete(userId);
  });

  // On shutdown: checkpoint all remaining sessions
  events.on('server:shutdown', async () => {
    for (const [userId, context] of activeSessions) {
      await checkpoint(userId, context, 'shutdown').catch(() => {});
    }
    activeSessions.clear();
  });

  app.delete('/sessions/:userId/cookies', ctx.auth(), async (req, res) => {
    const userId = ctx.normalizeUserId(req.params.userId);
    try {
      const context = activeSessions.get(userId);
      const clearedLive = Boolean(context);
      if (context) await context.clearCookies();

      const { storageStatePath, metaPath } = getUserPersistencePaths(profileDir, userId);
      const removedPersisted = await removeIfExists(storageStatePath);
      await removeIfExists(metaPath);

      log('info', 'session cookies cleared', { reqId: req.reqId, userId, clearedLive, removedPersisted });
      res.json({ ok: true, userId, clearedLive, removedPersisted });
    } catch (err) {
      log('error', 'clear cookies failed', { reqId: req.reqId, userId, error: err.message });
      res.status(500).json({ error: ctx.safeError(err) });
    }
  });

  log('info', 'persistence plugin: registered DELETE /sessions/:userId/cookies');
}
