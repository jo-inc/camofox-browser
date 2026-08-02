import { acquirePageLease, releasePageLease, setLeasedPage } from './page-lease.js';

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
}) {
  const inheritedRequestProxy = session.requestProxy || null;
  let lease = acquirePageLease(session);
  try {
    const page = setLeasedPage(lease, await withTimeout(session.context.newPage(), timeoutMs, 'new page'));
    return { session, page, lease };
  } catch (err) {
    releasePageLease(session, lease);
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

    const recoveryOptions = { trace };
    if (inheritedRequestProxy) {
      recoveryOptions.inheritedRequestProxy = inheritedRequestProxy;
    }
    session = await getSession(userId, recoveryOptions);
    lease = acquirePageLease(session);
    try {
      const page = setLeasedPage(lease, await withTimeout(session.context.newPage(), timeoutMs, 'new page retry'));
      return { session, page, lease };
    } catch (retryErr) {
      releasePageLease(session, lease);
      throw retryErr;
    }
  }
}
