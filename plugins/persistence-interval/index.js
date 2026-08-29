/**
 * Periodic storage-state checkpointing for camofox-browser.
 *
 * The persistence plugin writes storage state on five events -- bootstrap
 * cookie import, cookie import, storage export, session teardown and server
 * shutdown -- and on no timer. A session that lives a long time and then dies
 * ungracefully (SIGKILL, OOM, browser crash, host reboot) loses every cookie
 * and origin entry it accumulated, because none of those five fire. The
 * exposure window is the session lifetime, so it grows with SESSION_TIMEOUT_MS.
 *
 * Timer-based checkpointing in core was proposed and declined in #7223, on the
 * grounds that it "adds continuous serialization and coordination even when
 * storage hasn't changed", with the suggestion that it would work as a separate
 * plugin. This is that plugin. It uses only the public plugin context and
 * requires no core changes.
 *
 * It emits the same `session:storage:export` event that the vnc plugin's
 * GET /sessions/:userId/storage_state emits, so the persistence plugin does the
 * writing and exactly one code path touches the profile on disk. Because
 * persistence already serialises checkpoints per userId, a periodic checkpoint
 * cannot race an event-driven one.
 *
 * It also decouples on-demand checkpointing from the vnc plugin, which
 * registers the only route capable of forcing one and which ships disabled.
 *
 * Off unless configured, in camofox.config.json:
 *
 *   "plugins": {
 *     "persistence-interval": { "enabled": true, "intervalMs": 300000 }
 *   }
 */
export async function register(_app, ctx, pluginConfig = {}) {
  const { events, sessions, log } = ctx;

  // Note `Number(...) || 0` rather than the `parseInt(env) || default` idiom
  // used elsewhere: there, a zero silently restores the default. Here zero must
  // mean off, because "checkpoint every 0ms" has no sensible reading and a
  // surprise default would be a busy loop.
  const intervalMs = Number(pluginConfig.intervalMs) || 0;
  if (!Number.isFinite(intervalMs) || intervalMs <= 0) {
    log('info', 'persistence-interval plugin: disabled (set plugins["persistence-interval"].intervalMs)');
    return;
  }

  const checkpointAll = async () => {
    // Snapshot the entries first: a session destroyed mid-loop would otherwise
    // mutate the Map being iterated.
    for (const [userId, session] of [...sessions.entries()]) {
      try {
        const state = await session?.context?.storageState(ctx.persistenceStorageStateOptions);
        if (!state) continue;
        await events.emitAsync('session:storage:export', {
          userId: String(userId),
          storageState: state,
        });
      } catch (err) {
        // A dead or closing context is expected and routine. Swallow it per
        // session: one bad context must not skip the others, and must not kill
        // the timer -- a browser that just died is precisely when the remaining
        // sessions' accumulated state is most worth saving.
        log('warn', 'persistence-interval: checkpoint failed', {
          userId: String(userId),
          error: err?.message || String(err),
        });
      }
    }
  };

  const timer = setInterval(() => { void checkpointAll(); }, intervalMs);
  // Do not hold the event loop open: the checkpoint is a nicety, not a reason
  // for the process to refuse to exit.
  timer.unref?.();

  events.on('server:shutdown', () => clearInterval(timer));

  log('info', 'persistence-interval plugin enabled', { intervalMs });
}
