/**
 * Storage-state export handler shared by core and plugins.
 *
 * Storage state contains authenticated browser material. Callers must install
 * auth() before this handler and must not log the returned values.
 */
export function createStorageStateExportHandler({
  sessions,
  normalizeUserId = String,
  getStorageStateOptions = () => undefined,
  events,
  log,
}) {
  return async function exportStorageState(req, res) {
    const userId = normalizeUserId(req.params.userId);
    try {
      const session = sessions.get(userId);
      if (!session || session._closing) {
        return res.status(404).json({ error: `No active session for userId="${userId}"` });
      }

      const state = await session.context.storageState(getStorageStateOptions());
      const cookies = Array.isArray(state.cookies) ? state.cookies.length : 0;
      const origins = Array.isArray(state.origins) ? state.origins.length : 0;

      // Deliberately log only shape metadata, never cookie or storage values.
      log('info', 'storage_state exported', { reqId: req.reqId, cookies, origins });
      if (events && typeof events.emitAsync === 'function') {
        await events.emitAsync('session:storage:export', { userId, storageState: state });
      }
      res.json(state);
    } catch (err) {
      // Playwright errors can include page data; do not put them in logs or responses.
      log('error', 'storage_state export failed', { reqId: req.reqId });
      res.status(500).json({ error: 'Internal server error' });
    }
  };
}
