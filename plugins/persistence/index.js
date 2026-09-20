/**
 * Persistence plugin for camofox-browser.
 *
 * Saves and restores per-user browser storage state for normal contexts and
 * delegates native persistent contexts to Firefox's userDataDir/session store.
 *
 * Normal-context state is checkpointed periodically, on cookie import, on
 * explicit checkpoint requests, on session close, and on shutdown. Native
 * persistent checkpoints are metadata-only to avoid hanging Juggler exports.
 *
 * Configuration (camofox.config.json):
 *   {
 *     "plugins": {
 *       "persistence": {
 *         "enabled": true,
 *         "profileDir": "/data/profiles",
 *         "checkpointIntervalMs": 30000
 *       }
 *     }
 *   }
 *
 * Or via environment variables (overrides config file):
 *   CAMOFOX_PROFILE_DIR=/data/profiles
 *   CAMOFOX_CHECKPOINT_INTERVAL_MS=30000
 *
 * Normal-context userIds map to deterministic SHA256-hashed subdirectories
 * under profileDir. Native persistent profiles are shared identity boundaries
 * and keep browser state in their configured userDataDir.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import {
  loadPersistedStorageState,
  persistStorageState,
} from '../../lib/persistence.js';
import { importBootstrapCookies } from '../../lib/cookies.js';

export async function register(app, ctx, pluginConfig = {}) {
  const { events, config, log, sessions, safeError } = ctx;

  // Resolve profileDir: env var > plugin config > global config default (~/.camofox/profiles)
  const profileDir = process.env.CAMOFOX_PROFILE_DIR || pluginConfig.profileDir || config.profileDir;
  if (!profileDir) {
    log('warn', 'persistence plugin: no profileDir configured, plugin disabled');
    return;
  }

  const checkpointIntervalMs = Number(
    process.env.CAMOFOX_CHECKPOINT_INTERVAL_MS
    ?? pluginConfig.checkpointIntervalMs
    ?? 30_000
  );
  const checkpointTimeoutMs = Number(
    process.env.CAMOFOX_CHECKPOINT_TIMEOUT_MS
    ?? pluginConfig.checkpointTimeoutMs
    ?? 8_000
  );

  const logger = {
    warn: (msg, fields = {}) => log('warn', msg, fields),
  };

  log('info', 'persistence plugin enabled', { profileDir, checkpointIntervalMs, checkpointTimeoutMs });

  // Track active sessions for checkpoint on close.
  const activeSessions = new Map(); // userId -> context
  const inflightCheckpoints = new Map(); // userId -> Promise
  const nativeBootstrapMarker = path.join(profileDir, '.native-bootstrap-imported.json');
  let nativeBootstrapPromise = null;

  /**
   * Checkpoint storage state to disk for a userId. Serializes checkpoints per
   * user so periodic/manual/shutdown saves cannot race each other.
   */
  async function checkpoint(userId, context, reason, { authoritative = false } = {}) {
    if (!context) return { persisted: false, reason: 'no_context' };
    const key = String(userId);
    const previous = inflightCheckpoints.get(key) || Promise.resolve();

    log('info', 'storage state checkpoint queued', {
      userId: key,
      reason,
      nativeProfile: !!config.persistentContext,
      waitingForPrevious: inflightCheckpoints.has(key),
    });

    // Chain the real operation after the previous one. The in-flight map tracks
    // the underlying write, not the caller timeout, so a timed-out export must
    // finish before any later checkpoint can begin.
    const operation = previous.catch(() => {}).then(() => persistStorageState({
      profileDir,
      userId: key,
      context,
      logger,
      nativeProfile: !!config.persistentContext,
    }));
    const tail = operation.finally(() => {
      if (inflightCheckpoints.get(key) === tail) inflightCheckpoints.delete(key);
    });
    inflightCheckpoints.set(key, tail);

    let result = await Promise.race([
      tail,
      new Promise((resolve) => setTimeout(() => resolve({
        persisted: false,
        reason: 'timeout',
        error: `checkpoint timed out after ${checkpointTimeoutMs}ms`,
      }), checkpointTimeoutMs)),
    ]);

    if (authoritative && result.reason === 'timeout') {
      log('warn', 'authoritative storage checkpoint exceeded warning timeout; waiting for the final save', {
        userId: key,
        reason,
        checkpointTimeoutMs,
      });
      result = await tail;
    }

    if (result.persisted) {
      log('info', 'storage state persisted', { userId: key, reason, path: result.storageStatePath });
    }
    return result;
  }

  async function checkpointActiveSession(userId, reason) {
    const key = String(userId);
    const context = activeSessions.get(key);
    if (!context) return { persisted: false, reason: 'no_active_session' };
    return checkpoint(key, context, reason);
  }

  // --- Lifecycle hooks ---

  // Before a normal session context is created, inject saved storage state.
  // Native persistent contexts restore from their Firefox userDataDir instead.
  events.on('session:creating', async ({ userId, contextOptions }) => {
    if (config.persistentContext) return;
    const storageStatePath = await loadPersistedStorageState(profileDir, userId, logger);
    if (storageStatePath) {
      contextOptions.storageState = storageStatePath;
      log('info', 'restoring persisted storage state', { userId, storageStatePath });
    }
  });

  // After session creation, track the context. Bootstrap cookies are imported
  // once per native profile (marker survives restarts), or once per normal user
  // before their first storage-state checkpoint.
  events.on('session:created', async ({ userId, context }) => {
    const key = String(userId);
    activeSessions.set(key, context);

    if (config.persistentContext) {
      if (!nativeBootstrapPromise) {
        nativeBootstrapPromise = (async () => {
          try {
            await fs.access(nativeBootstrapMarker);
            return;
          } catch (_) {
            // No marker: this native profile has not imported bootstrap cookies.
          }
          const result = await importBootstrapCookies({
            cookiesDir: config.cookiesDir,
            context,
            logger,
          });
          if (result.imported > 0) {
            await fs.mkdir(profileDir, { recursive: true });
            await fs.writeFile(nativeBootstrapMarker, JSON.stringify({ importedAt: new Date().toISOString() }));
            log('info', 'native profile bootstrap cookies imported', { count: result.imported, source: result.source });
          }
        })();
      }
      await nativeBootstrapPromise;
      return;
    }

    const existingState = await loadPersistedStorageState(profileDir, key, logger);
    if (!existingState) {
      const result = await importBootstrapCookies({
        cookiesDir: config.cookiesDir,
        context,
        logger,
      });
      if (result.imported > 0) {
        log('info', 'bootstrap cookies imported', { userId: key, count: result.imported, source: result.source });
        await checkpoint(key, context, 'bootstrap_cookies');
      }
    }
  });

  // On cookie import: checkpoint.
  events.on('session:cookies:import', async ({ userId }) => {
    await checkpointActiveSession(userId, 'cookie_import');
  });

  // On storage export/manual save requests: checkpoint too. This lets a human
  // finish an auth flow over noVNC and save without closing the browser.
  events.on('session:storage:export', async ({ userId }) => {
    await checkpointActiveSession(userId, 'storage_export');
  });

  // On session destroying (pre-close): checkpoint while context is still alive.
  events.on('session:destroying', async ({ userId, reason, context: destroyingContext }) => {
    const key = String(userId);
    const context = activeSessions.get(key);
    if (context && (!destroyingContext || context === destroyingContext)) {
      // A close is the authoritative final save for normal contexts. Never skip
      // it because storage may have changed after a recent periodic checkpoint.
      await checkpoint(key, context, reason, { authoritative: true }).catch(() => {});
      if (activeSessions.get(key) === context) activeSessions.delete(key);
    }
  });

  // On session destroyed (post-close), cleanup only the context that emitted
  // the event so a concurrently recreated session is never untracked.
  events.on('session:destroyed', async ({ userId, context: destroyedContext }) => {
    const key = String(userId);
    if (!destroyedContext || activeSessions.get(key) === destroyedContext) {
      activeSessions.delete(key);
    }
  });

  let checkpointTimer = null;

  // On shutdown: checkpoint all remaining sessions.
  events.on('server:shutdown', async () => {
    if (checkpointTimer) clearInterval(checkpointTimer);
    for (const [userId, context] of activeSessions) {
      await checkpoint(userId, context, 'shutdown', { authoritative: true }).catch(() => {});
    }
    activeSessions.clear();
  });

  // Periodically save active accounts so a crash/restart does not lose fresh
  // login cookies. Keep the timer unref'd so it never holds the process open.
  if (checkpointIntervalMs > 0) {
    checkpointTimer = setInterval(() => {
      for (const [userId, context] of activeSessions) {
        checkpoint(userId, context, 'periodic').catch(() => {});
      }
    }, checkpointIntervalMs);
    checkpointTimer.unref?.();
  }

  // Explicit checkpoint endpoint for post-login workflows. If the host does
  // not provide its shared auth factory, fail closed by not mounting routes.
  const authMiddleware = typeof ctx.auth === 'function' ? ctx.auth() : null;
  if (typeof app.post === 'function' && authMiddleware) {
    app.post('/sessions/checkpoint_all', authMiddleware, async (_req, res) => {
      try {
        const results = [];
        for (const [userId, context] of activeSessions) {
          const result = await checkpoint(userId, context, 'manual_checkpoint_all');
          results.push({ userId, ok: !!result?.persisted, ...result });
        }
        res.json({ ok: true, count: results.length, results });
      } catch (err) {
        log('error', 'manual all-session storage checkpoint failed', { error: err.message });
        res.status(500).json({ ok: false, error: safeError ? safeError(err) : err.message });
      }
    });

    app.post('/sessions/:userId/checkpoint', authMiddleware, async (req, res) => {
      try {
        const userId = String(req.params.userId);
        const session = sessions?.get?.(userId);
        const context = session?.context || activeSessions.get(userId);
        if (!context) {
          return res.status(404).json({ ok: false, error: `No active session for userId="${userId}"` });
        }
        const result = await checkpoint(userId, context, 'manual_checkpoint');
        res.json({ ok: !!result?.persisted, ...result });
      } catch (err) {
        log('error', 'manual storage checkpoint failed', { reqId: req.reqId, error: err.message });
        res.status(500).json({ ok: false, error: safeError ? safeError(err) : err.message });
      }
    });
  }
}
