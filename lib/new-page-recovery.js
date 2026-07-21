export async function createPageWithSessionRecovery({
  userId,
  session,
  trace = false,
  timeoutMs,
  withTimeout,
  isTimeoutError,
  isDeadContextError,
  currentSession,
  destroySession,
  getSession,
  log,
  reservePendingCreation = () => () => {},
}) {
  const createPage = (activeSession, label) => {
    const releasePendingCreation = reservePendingCreation(activeSession);
    const pagePromise = Promise.resolve().then(() => activeSession.context.newPage());
    // A timeout does not necessarily settle the underlying newPage promise.
    // Keep the reaper reservation until the real attempt resolves or rejects.
    pagePromise.then(releasePendingCreation, releasePendingCreation);
    return withTimeout(pagePromise, timeoutMs, label);
  };

  try {
    const page = await createPage(session, 'new page');
    return { session, page };
  } catch (err) {
    if (!isTimeoutError(err) && !isDeadContextError(err)) throw err;

    log('warn', 'new page failed, recreating user session', {
      userId,
      error: err.message,
    });

    // Another request may already have replaced this session. Never tear down
    // a newer healthy context while recovering the one that failed.
    if (currentSession() === session) {
      await destroySession(userId, { reason: 'new_page_unresponsive' });
    }

    session = await getSession(userId, { trace });
    const page = await createPage(session, 'new page retry');
    return { session, page };
  }
}
