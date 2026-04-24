/**
 * Persistence plugin for camofox-browser.
 *
 * Saves and restores per-user browser storage state (cookies + localStorage)
 * across session restarts using Playwright's storageState API.
 *
 * Configuration (camofox.config.json):
 *   {
 *     "plugins": {
 *       "persistence": {
 *         "enabled": true,
 *         "profileDir": "/data/profiles"
 *       }
 *     }
 *   }
 *
 * Or via environment variables (overrides config file):
 *   CAMOFOX_PROFILE_DIR=/data/profiles
 *
 * Each userId gets a deterministic SHA256-hashed subdirectory under profileDir.
 * Storage state is checkpointed on cookie import, session close, and shutdown.
 * On session creation, saved state is restored into the new Playwright context
 * via the session:creating hook (mutates contextOptions.storageState).
 */

import {
  getUserPersistencePaths,
  loadPersistedStorageState,
  persistStorageState,
} from '../../lib/persistence.js';
import { importBootstrapCookies } from '../../lib/cookies.js';

export async function register(app, ctx, pluginConfig = {}) {
  const { events, config, log } = ctx;

  // Resolve profileDir: env var > plugin config > global config default (~/.camofox/profiles)
  const profileDir = process.env.CAMOFOX_PROFILE_DIR || pluginConfig.profileDir || config.profileDir;
  if (!profileDir) {
    log('warn', 'persistence plugin: no profileDir configured, plugin disabled');
    return;
  }

  const logger = {
    warn: (msg, fields = {}) => log('warn', msg, fields),
  };

  log('info', 'persistence plugin enabled', { profileDir });

  // Track active sessions for checkpoint on close
  const activeSessions = new Map(); // userId -> context

  /**
   * Checkpoint storage state to disk for a userId.
   */
  async function checkpoint(userId, context, reason) {
    if (!context) return;
    const result = await persistStorageState({ profileDir, userId, context, logger });
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
}
