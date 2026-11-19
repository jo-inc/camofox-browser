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
  isSessionResponsive = session => probeSession(session, withTimeout, timeoutMs),
  log,
}) {
  let lease = acquirePageLease(session);
  let pagePromise;
  try {
    pagePromise = session.context.newPage();
    const page = setLeasedPage(lease, await withTimeout(pagePromise, timeoutMs, 'new page'));
    return { session, page, lease };
  } catch (err) {
    releasePageLease(session, lease);
    if (!isTimeoutError(err) && !isDeadContextError(err)) throw err;

    if (isTimeoutError(err) && await isSessionResponsive(session)) {
      // The timed-out Playwright call may still finish later. Close its page so
      // the preserved session does not accumulate an unregistered tab.
      if (pagePromise?.then) {
        pagePromise.then(async page => {
          try {
            await page.close();
          } catch {}
        }, () => {});
      }
      log('warn', 'new page timed out but session is responsive; preserving user session', {
        userId,
        error: err.message,
      });
      throw Object.assign(err, {
        code: 'new_page_timeout',
        statusCode: 503,
      });
    }

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

async function probeSession(session, withTimeout, timeoutMs) {
  try {
    const pages = session.context.pages().filter(page => !page.isClosed());
    if (pages.length === 0) return false;
    const probes = pages.map(page =>
      withTimeout(page.evaluate(() => true), Math.min(timeoutMs, 1000), 'session liveness probe')
        .then(() => true, () => false)
    );
    return await Promise.any(probes).catch(() => false);
  } catch {
    return false;
  }
}
