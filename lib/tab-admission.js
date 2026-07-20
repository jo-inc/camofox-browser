export class TabAdmissionError extends Error {
  constructor(message, { code, retryAfter, statusCode = 429 } = {}) {
    super(message);
    this.name = 'TabAdmissionError';
    this.statusCode = statusCode;
    this.code = code;
    this.retryAfter = retryAfter;
  }
}

function positiveInteger(value, fallback) {
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

export class TabAdmissionController {
  constructor({
    maxActive,
    maxActivePerUser,
    maxPending,
    waitTimeoutMs = 0,
    operationTimeoutMs = 0,
    retryAfterSeconds = 2,
    onStateChange = () => {},
    onRejected = () => {},
    onTimeout = () => {},
  }) {
    this.maxActive = positiveInteger(maxActive, 1);
    this.maxActivePerUser = positiveInteger(maxActivePerUser, 1);
    this.maxPending = positiveInteger(maxPending, 1);
    this.waitTimeoutMs = Number.isFinite(waitTimeoutMs) && waitTimeoutMs > 0 ? waitTimeoutMs : 0;
    this.operationTimeoutMs = Number.isFinite(operationTimeoutMs) && operationTimeoutMs > 0 ? operationTimeoutMs : 0;
    this.retryAfterSeconds = positiveInteger(retryAfterSeconds, 2);
    this.onStateChange = onStateChange;
    this.onRejected = onRejected;
    this.onTimeout = onTimeout;
    this.active = 0;
    this.pending = 0;
    this.activeByUser = new Map();
    this.queue = [];
  }

  snapshot() {
    return {
      active: this.active,
      pending: this.pending,
      activeByUser: Object.fromEntries(this.activeByUser),
    };
  }

  run(userKey, operation) {
    const key = String(userKey);
    const canStartNow = this.#canStart(key);
    if (!canStartNow && this.pending >= this.maxPending) {
      this.onRejected();
      return Promise.reject(new TabAdmissionError('Tab admission queue is full', {
        code: 'tab_admission_queue_full',
        retryAfter: this.retryAfterSeconds,
      }));
    }

    return new Promise((resolve, reject) => {
      const entry = {
        key,
        operation,
        resolve,
        reject,
        queued: true,
        responded: false,
        waitTimer: null,
      };
      this.queue.push(entry);
      this.pending += 1;

      if (this.waitTimeoutMs > 0) {
        entry.waitTimer = setTimeout(() => this.#expireQueued(entry), this.waitTimeoutMs);
      }

      this.#stateChanged();
      this.#pump();
    });
  }

  #canStart(key) {
    return this.active < this.maxActive && (this.activeByUser.get(key) || 0) < this.maxActivePerUser;
  }

  #expireQueued(entry) {
    if (!entry.queued) return;
    const index = this.queue.indexOf(entry);
    if (index < 0) return;
    this.queue.splice(index, 1);
    entry.queued = false;
    this.pending -= 1;
    this.onTimeout('wait');
    this.#stateChanged();
    entry.responded = true;
    entry.reject(new TabAdmissionError('Tab admission wait timed out', {
      code: 'tab_admission_wait_timeout',
      retryAfter: this.retryAfterSeconds,
    }));
    this.#pump();
  }

  #pump() {
    while (this.active < this.maxActive) {
      const index = this.queue.findIndex((entry) => this.#canStart(entry.key));
      if (index < 0) return;
      const [entry] = this.queue.splice(index, 1);
      this.#start(entry);
    }
  }

  #start(entry) {
    entry.queued = false;
    clearTimeout(entry.waitTimer);
    this.pending -= 1;
    this.active += 1;
    this.activeByUser.set(entry.key, (this.activeByUser.get(entry.key) || 0) + 1);
    this.#stateChanged();

    const abortController = new AbortController();
    let operationTimer = null;
    if (this.operationTimeoutMs > 0) {
      operationTimer = setTimeout(() => {
        if (entry.responded) return;
        const error = new TabAdmissionError('Tab creation timed out', {
          code: 'tab_admission_operation_timeout',
          retryAfter: this.retryAfterSeconds,
        });
        entry.responded = true;
        this.onTimeout('operation');
        abortController.abort(error);
        entry.reject(error);
      }, this.operationTimeoutMs);
    }

    Promise.resolve()
      .then(() => entry.operation(abortController.signal))
      .then(
        (value) => {
          if (entry.responded) return;
          entry.responded = true;
          entry.resolve(value);
        },
        (error) => {
          if (entry.responded) return;
          entry.responded = true;
          entry.reject(error);
        },
      )
      .finally(() => {
        clearTimeout(operationTimer);
        this.active -= 1;
        const remaining = (this.activeByUser.get(entry.key) || 1) - 1;
        if (remaining > 0) this.activeByUser.set(entry.key, remaining);
        else this.activeByUser.delete(entry.key);
        this.#stateChanged();
        this.#pump();
      });
  }

  #stateChanged() {
    this.onStateChange(this.snapshot());
  }
}

export class TabCapacityReservations {
  constructor({
    maxGlobal,
    maxPerUser,
    getGlobalCount,
    getUserCount,
    retryAfterSeconds = 2,
    onRejected = () => {},
  }) {
    this.maxGlobal = positiveInteger(maxGlobal, 1);
    this.maxPerUser = positiveInteger(maxPerUser, 1);
    this.getGlobalCount = getGlobalCount;
    this.getUserCount = getUserCount;
    this.retryAfterSeconds = positiveInteger(retryAfterSeconds, 2);
    this.onRejected = onRejected;
    this.reservedGlobal = 0;
    this.reservedByUser = new Map();
  }

  reserve(userKey) {
    const key = String(userKey);
    const userReserved = this.reservedByUser.get(key) || 0;
    if (this.getUserCount(key) + userReserved >= this.maxPerUser) {
      this.onRejected();
      throw new TabAdmissionError('Maximum tabs per user reached', {
        code: 'tab_admission_user_limit',
        retryAfter: this.retryAfterSeconds,
      });
    }
    if (this.getGlobalCount() + this.reservedGlobal >= this.maxGlobal) {
      this.onRejected();
      throw new TabAdmissionError('Maximum global tabs reached', {
        code: 'tab_admission_global_limit',
        retryAfter: this.retryAfterSeconds,
      });
    }

    this.reservedGlobal += 1;
    this.reservedByUser.set(key, userReserved + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.reservedGlobal -= 1;
      const remaining = (this.reservedByUser.get(key) || 1) - 1;
      if (remaining > 0) this.reservedByUser.set(key, remaining);
      else this.reservedByUser.delete(key);
    };
  }
}

export function sendTabAdmissionError(response, error, safeMessage = error?.message) {
  if (error?.statusCode !== 429 || !error?.code?.startsWith('tab_admission_')) return false;
  response.set('Retry-After', String(error.retryAfter));
  response.status(429).json({
    error: safeMessage,
    code: error.code,
    retryAfter: error.retryAfter,
  });
  return true;
}

export async function awaitAbortableResource(resourcePromise, signal, cleanup) {
  const resource = await resourcePromise;
  if (!signal?.aborted) return resource;
  await cleanup(resource);
  throw signal.reason instanceof Error ? signal.reason : new Error('Operation aborted');
}

export async function withAbortableResource({
  create,
  signal,
  register,
  unregister,
  cleanup,
  operation,
}) {
  let resource;
  let registered = false;
  let cleanupPromise = null;
  const abortError = () => signal?.reason instanceof Error ? signal.reason : new Error('Operation aborted');
  const cleanupOnce = () => {
    if (!resource) return Promise.resolve();
    if (!cleanupPromise) cleanupPromise = Promise.resolve(cleanup(resource));
    return cleanupPromise;
  };
  const onAbort = () => { cleanupOnce().catch(() => {}); };

  try {
    resource = await awaitAbortableResource(Promise.resolve().then(create), signal, cleanup);
    registered = true;
    await register(resource);
    if (signal?.aborted) throw abortError();
    signal?.addEventListener('abort', onAbort, { once: true });
    const result = await operation(resource);
    if (signal?.aborted) throw abortError();
    return result;
  } catch (error) {
    try {
      if (registered) await unregister(resource);
    } finally {
      await cleanupOnce();
    }
    throw error;
  } finally {
    signal?.removeEventListener('abort', onAbort);
  }
}
