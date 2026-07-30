function lifecycleConflict() {
  return Object.assign(new Error('Session deletion is already in flight'), {
    statusCode: 409,
    code: 'session_deletion_inflight',
  });
}

export function attachOperationCompletion(response, finish) {
  let completed = false;
  const complete = () => {
    if (completed) return;
    completed = true;
    finish();
  };
  if (response.destroyed || response.writableEnded) {
    complete();
    return false;
  }
  const originalEnd = response.end;
  response.end = function operationAwareEnd(...args) {
    const result = originalEnd.apply(this, args);
    complete();
    return result;
  };
  if (typeof response.destroy === 'function') {
    const originalDestroy = response.destroy;
    response.destroy = function operationAwareDestroy(...args) {
      const result = originalDestroy.apply(this, args);
      complete();
      return result;
    };
  }
  return true;
}

export function trackOperationPromise(coordinator, userId, promise) {
  const finish = coordinator.extend(userId);
  return Promise.resolve(promise).finally(finish);
}

export async function runCoordinatedDeletion(coordinator, userId, operation) {
  const finishDelete = await coordinator.beginDelete(userId);
  try {
    return await operation();
  } finally {
    finishDelete();
  }
}

export function createSessionOperationCoordinator() {
  const states = new Map();

  function stateFor(userId) {
    let state = states.get(userId);
    if (!state) {
      state = { active: 0, deleting: false, idleWaiters: [] };
      states.set(userId, state);
    }
    return state;
  }

  function cleanup(userId, state) {
    if (state.active === 0 && !state.deleting && state.idleWaiters.length === 0) {
      states.delete(userId);
    }
  }

  function enter(userId) {
    const state = stateFor(userId);
    if (state.deleting) {
      cleanup(userId, state);
      throw lifecycleConflict();
    }
    state.active += 1;
    let finished = false;
    return () => {
      if (finished) return;
      finished = true;
      state.active -= 1;
      if (state.active === 0) {
        const waiters = state.idleWaiters.splice(0);
        for (const resolve of waiters) resolve();
      }
      cleanup(userId, state);
    };
  }

  function extend(userId) {
    const state = states.get(userId);
    if (!state || state.active === 0) throw lifecycleConflict();
    state.active += 1;
    let finished = false;
    return () => {
      if (finished) return;
      finished = true;
      state.active -= 1;
      if (state.active === 0) {
        const waiters = state.idleWaiters.splice(0);
        for (const resolve of waiters) resolve();
      }
      cleanup(userId, state);
    };
  }

  async function beginDelete(userId) {
    const state = stateFor(userId);
    if (state.deleting) throw lifecycleConflict();
    state.deleting = true;
    if (state.active > 0) {
      await new Promise(resolve => state.idleWaiters.push(resolve));
    }
    let finished = false;
    return () => {
      if (finished) return;
      finished = true;
      state.deleting = false;
      cleanup(userId, state);
    };
  }

  return {
    enter,
    extend,
    beginDelete,
    isActive: userId => {
      const state = states.get(userId);
      return !!state && (state.active > 0 || state.deleting);
    },
    size: () => states.size,
  };
}
