import { jest } from '@jest/globals';
import {
  TabAdmissionController,
  TabCapacityReservations,
  awaitAbortableResource,
  sendTabAdmissionError,
  withAbortableResource,
} from '../../lib/tab-admission.js';

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

async function flush() {
  await Promise.resolve();
  await Promise.resolve();
}

describe('TabAdmissionController', () => {
  test('enforces the global active limit and starts queued work after release', async () => {
    const controller = new TabAdmissionController({ maxActive: 2, maxActivePerUser: 2, maxPending: 4 });
    const gates = [deferred(), deferred(), deferred()];
    const started = [];

    const runs = gates.map((gate, index) => controller.run(`user-${index}`, async () => {
      started.push(index);
      return gate.promise;
    }));
    await flush();

    expect(started).toEqual([0, 1]);
    expect(controller.snapshot()).toMatchObject({ active: 2, pending: 1 });

    gates[0].resolve('first');
    await expect(runs[0]).resolves.toBe('first');
    await flush();
    expect(started).toEqual([0, 1, 2]);

    gates[1].resolve('second');
    gates[2].resolve('third');
    await expect(Promise.all(runs.slice(1))).resolves.toEqual(['second', 'third']);
    expect(controller.snapshot()).toMatchObject({ active: 0, pending: 0 });
  });

  test('enforces per-user active limit without head-of-line blocking another user', async () => {
    const controller = new TabAdmissionController({ maxActive: 2, maxActivePerUser: 1, maxPending: 4 });
    const first = deferred();
    const second = deferred();
    const other = deferred();
    const started = [];

    const run1 = controller.run('same-user', async () => { started.push('same-1'); return first.promise; });
    const run2 = controller.run('same-user', async () => { started.push('same-2'); return second.promise; });
    const run3 = controller.run('other-user', async () => { started.push('other'); return other.promise; });
    await flush();

    expect(started).toEqual(['same-1', 'other']);
    first.resolve('one');
    await expect(run1).resolves.toBe('one');
    await flush();
    expect(started).toEqual(['same-1', 'other', 'same-2']);

    second.resolve('two');
    other.resolve('other');
    await expect(Promise.all([run2, run3])).resolves.toEqual(['two', 'other']);
  });

  test('bounds the pending queue and rejects overflow with 429 retry metadata', async () => {
    const controller = new TabAdmissionController({
      maxActive: 1,
      maxActivePerUser: 1,
      maxPending: 2,
      retryAfterSeconds: 7,
    });
    const active = deferred();
    const queued1 = deferred();
    const queued2 = deferred();

    const run1 = controller.run('u1', () => active.promise);
    const run2 = controller.run('u2', () => queued1.promise);
    const run3 = controller.run('u3', () => queued2.promise);
    await flush();

    await expect(controller.run('u4', async () => 'never')).rejects.toMatchObject({
      statusCode: 429,
      code: 'tab_admission_queue_full',
      retryAfter: 7,
    });

    active.resolve('active');
    await run1;
    queued1.resolve('q1');
    await run2;
    queued2.resolve('q2');
    await run3;
  });

  test.each([
    ['success', async () => 'ok'],
    ['error', async () => { throw new Error('boom'); }],
  ])('releases capacity after operation %s', async (_label, operation) => {
    const controller = new TabAdmissionController({ maxActive: 1, maxActivePerUser: 1, maxPending: 1 });
    const first = controller.run('u1', operation);
    const second = controller.run('u2', async () => 'next');

    if (_label === 'success') await expect(first).resolves.toBe('ok');
    else await expect(first).rejects.toThrow('boom');
    await expect(second).resolves.toBe('next');
    expect(controller.snapshot()).toMatchObject({ active: 0, pending: 0 });
  });

  test('times out active work, aborts it, and releases only after late settlement', async () => {
    jest.useFakeTimers();
    try {
      const controller = new TabAdmissionController({
        maxActive: 1,
        maxActivePerUser: 1,
        maxPending: 1,
        operationTimeoutMs: 100,
      });
      const late = deferred();
      let signal;
      const first = controller.run('u1', async (operationSignal) => {
        signal = operationSignal;
        return late.promise;
      });
      const firstRejection = expect(first).rejects.toMatchObject({ code: 'tab_admission_operation_timeout' });
      const second = controller.run('u2', async () => 'next');
      await flush();

      await jest.advanceTimersByTimeAsync(100);
      await firstRejection;
      expect(signal.aborted).toBe(true);
      expect(controller.snapshot()).toMatchObject({ active: 1, pending: 1 });

      late.resolve('ignored');
      await flush();
      await expect(second).resolves.toBe('next');
      expect(controller.snapshot()).toMatchObject({ active: 0, pending: 0 });
    } finally {
      jest.useRealTimers();
    }
  });

  test('times out queued work and removes it fairly', async () => {
    jest.useFakeTimers();
    try {
      const controller = new TabAdmissionController({
        maxActive: 1,
        maxActivePerUser: 1,
        maxPending: 2,
        waitTimeoutMs: 100,
      });
      const active = deferred();
      const run1 = controller.run('u1', () => active.promise);
      const queued = controller.run('u2', async () => 'never');
      const queuedRejection = expect(queued).rejects.toMatchObject({
        statusCode: 429,
        code: 'tab_admission_wait_timeout',
      });
      await flush();

      await jest.advanceTimersByTimeAsync(100);
      await queuedRejection;
      expect(controller.snapshot()).toMatchObject({ active: 1, pending: 0 });

      active.resolve('done');
      await expect(run1).resolves.toBe('done');
    } finally {
      jest.useRealTimers();
    }
  });
});

describe('TabCapacityReservations', () => {
  test('atomically enforces resident global and per-user tab limits', () => {
    let globalTabs = 1;
    const userTabs = new Map([['u1', 1]]);
    const capacity = new TabCapacityReservations({
      maxGlobal: 2,
      maxPerUser: 2,
      getGlobalCount: () => globalTabs,
      getUserCount: (user) => userTabs.get(user) || 0,
      retryAfterSeconds: 3,
    });

    const release = capacity.reserve('u1');
    expect(() => capacity.reserve('u2')).toThrow(expect.objectContaining({
      statusCode: 429,
      code: 'tab_admission_global_limit',
      retryAfter: 3,
    }));
    expect(() => capacity.reserve('u1')).toThrow(expect.objectContaining({
      statusCode: 429,
      code: 'tab_admission_user_limit',
    }));

    release();
    expect(() => capacity.reserve('u2')).not.toThrow();
  });
});

describe('sendTabAdmissionError', () => {
  test('writes HTTP 429 JSON and Retry-After for admission overflow', () => {
    const response = {
      headers: {},
      statusCode: null,
      body: null,
      set(name, value) { this.headers[name] = value; return this; },
      status(value) { this.statusCode = value; return this; },
      json(value) { this.body = value; return this; },
    };
    const error = new Error('queue full');
    Object.assign(error, {
      statusCode: 429,
      code: 'tab_admission_queue_full',
      retryAfter: 5,
    });

    expect(sendTabAdmissionError(response, error, 'safe queue full')).toBe(true);
    expect(response.headers['Retry-After']).toBe('5');
    expect(response.statusCode).toBe(429);
    expect(response.body).toEqual({
      error: 'safe queue full',
      code: 'tab_admission_queue_full',
      retryAfter: 5,
    });
  });
});

describe('awaitAbortableResource', () => {
  test('closes a resource that resolves after its operation was aborted', async () => {
    const resource = deferred();
    const abort = new AbortController();
    const close = jest.fn(async () => {});
    const result = awaitAbortableResource(resource.promise, abort.signal, close);

    abort.abort(new Error('request timed out'));
    resource.resolve({ id: 'late-page' });

    await expect(result).rejects.toThrow('request timed out');
    expect(close).toHaveBeenCalledWith({ id: 'late-page' });
  });

  test('unregisters and closes a managed resource when work is aborted', async () => {
    const abort = new AbortController();
    const work = deferred();
    const registered = new Map();
    const close = jest.fn(async () => {});
    const resource = { id: 'tab-1' };

    const result = withAbortableResource({
      create: async () => resource,
      signal: abort.signal,
      register: async (value) => registered.set(value.id, value),
      unregister: async (value) => registered.delete(value.id),
      cleanup: close,
      operation: async () => work.promise,
    });
    await new Promise(setImmediate);
    expect(registered.has('tab-1')).toBe(true);

    abort.abort(new Error('request timed out'));
    work.reject(new Error('page closed'));

    await expect(result).rejects.toThrow('page closed');
    expect(registered.size).toBe(0);
    expect(close).toHaveBeenCalledWith(resource);
  });
});
