import { shouldPreserveRequestProxy } from './request-proxy.js';

export function isAutomaticSessionTeardown(reason) {
  return shouldPreserveRequestProxy(reason) || reason?.startsWith('nav_failure_recovery:') === true;
}

export function createSessionLifecycleTracker() {
  const generations = new Map();
  let nextGeneration = 0;

  function advance(userId) {
    const key = String(userId);
    const generation = ++nextGeneration;
    generations.set(key, generation);
    return generation;
  }

  return {
    begin: advance,
    invalidate: advance,
    isCurrent(userId, generation) {
      return generations.get(String(userId)) === generation;
    },
    release(userId, generation) {
      const key = String(userId);
      if (generations.get(key) !== generation) return false;
      return generations.delete(key);
    },
    get size() {
      return generations.size;
    },
  };
}

export function createLifecycleEpoch() {
  let epoch = 0;
  return {
    current() {
      return epoch;
    },
    advance() {
      return ++epoch;
    },
    isCurrent(candidate) {
      return candidate === epoch;
    },
  };
}

export function runSessionCloseOnce(session, close) {
  if (!session) return Promise.resolve();
  if (session._closePromise) return session._closePromise;

  session._closing = true;
  const closePromise = Promise.resolve().then(close);
  session._closePromise = closePromise;
  closePromise.catch(() => {
    if (session._closePromise === closePromise) delete session._closePromise;
  });
  return closePromise;
}

export function canPreserveSessionRecovery(lifecycle, userId, session, reason) {
  return isAutomaticSessionTeardown(reason) && lifecycle.isCurrent(userId, session?.generation);
}

export async function publishSessionIfCurrent({
  sessions,
  userId,
  session,
  generation,
  lifecycle,
  isStillCurrent = () => true,
  onCreated,
  onStale,
}) {
  const key = String(userId);
  const staleCause = () => {
    if (!lifecycle.isCurrent(key, generation)) return 'session_invalidated';
    if (!isStillCurrent()) return 'external_invalidated';
    return null;
  };

  const initialCause = staleCause();
  if (initialCause) {
    await onStale(session, initialCause);
    return false;
  }

  sessions.set(key, session);
  try {
    await onCreated(session);
  } catch (err) {
    if (sessions.get(key) === session) sessions.delete(key);
    await onStale(session, staleCause() || 'creation_failed');
    throw err;
  }

  const finalCause = staleCause();
  if (!finalCause && sessions.get(key) === session) {
    return true;
  }

  if (sessions.get(key) === session) sessions.delete(key);
  await onStale(session, finalCause || 'publication_lost');
  return false;
}
