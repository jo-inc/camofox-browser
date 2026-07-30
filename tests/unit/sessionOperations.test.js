import { EventEmitter } from 'events';
import { jest } from '@jest/globals';
import {
  attachOperationCompletion,
  createSessionOperationCoordinator,
  runCoordinatedDeletion,
  trackOperationPromise,
} from '../../lib/session-operations.js';

function nextTurn() {
  return new Promise(resolve => setImmediate(resolve));
}

describe('session operation coordinator', () => {
  test('deletion waits for active operations and blocks later operations until cleanup ends', async () => {
    const coordinator = createSessionOperationCoordinator();
    const finishOperation = coordinator.enter('user-a');
    expect(coordinator.isActive('user-a')).toBe(true);

    let deletionReady = false;
    const deletion = coordinator.beginDelete('user-a').then(finishDelete => {
      deletionReady = true;
      return finishDelete;
    });

    await nextTurn();
    expect(deletionReady).toBe(false);
    expect(() => coordinator.enter('user-a')).toThrow(expect.objectContaining({
      statusCode: 409,
      code: 'session_deletion_inflight',
    }));

    finishOperation();
    const finishDelete = await deletion;
    expect(deletionReady).toBe(true);
    expect(() => coordinator.enter('user-a')).toThrow(expect.objectContaining({
      statusCode: 409,
      code: 'session_deletion_inflight',
    }));

    finishDelete();
    const finishNextOperation = coordinator.enter('user-a');
    finishNextOperation();
    expect(coordinator.size()).toBe(0);
    expect(coordinator.isActive('user-a')).toBe(false);
  });

  test('rejects concurrent deletion and makes completion callbacks idempotent', async () => {
    const coordinator = createSessionOperationCoordinator();
    const finishDelete = await coordinator.beginDelete('user-a');

    await expect(coordinator.beginDelete('user-a')).rejects.toMatchObject({
      statusCode: 409,
      code: 'session_deletion_inflight',
    });

    finishDelete();
    finishDelete();
    expect(coordinator.size()).toBe(0);
  });

  test('tracks handler completion rather than client socket close', () => {
    const response = new EventEmitter();
    response.destroyed = false;
    response.writableEnded = false;
    response.end = jest.fn(() => {
      response.writableEnded = true;
    });
    const finish = jest.fn();

    expect(attachOperationCompletion(response, finish)).toBe(true);
    response.emit('close');
    expect(finish).not.toHaveBeenCalled();

    response.end('done');
    response.end('duplicate');
    expect(finish).toHaveBeenCalledTimes(1);
  });

  test('completes after an explicit response destroy settles', () => {
    const response = new EventEmitter();
    response.destroyed = false;
    response.writableEnded = false;
    response.end = jest.fn();
    response.destroy = jest.fn(() => {
      response.destroyed = true;
    });
    const finish = jest.fn();

    expect(attachOperationCompletion(response, finish)).toBe(true);
    response.destroy();
    expect(response.destroyed).toBe(true);
    expect(finish).toHaveBeenCalledTimes(1);
  });

  test('does not complete when response end or destroy throws', () => {
    for (const method of ['end', 'destroy']) {
      const response = new EventEmitter();
      response.destroyed = false;
      response.writableEnded = false;
      response.end = jest.fn();
      response.destroy = jest.fn();
      response[method].mockImplementation(() => { throw new Error(`${method} failed`); });
      const finish = jest.fn();

      expect(attachOperationCompletion(response, finish)).toBe(true);
      expect(() => response[method]()).toThrow(`${method} failed`);
      expect(finish).not.toHaveBeenCalled();
    }
  });

  test('keeps deletion blocked until a timed-out underlying promise settles', async () => {
    const coordinator = createSessionOperationCoordinator();
    const finishRequest = coordinator.enter('user-a');
    let settleUnderlying;
    const underlying = new Promise(resolve => { settleUnderlying = resolve; });
    const tracked = trackOperationPromise(coordinator, 'user-a', underlying);
    finishRequest();

    let deleteStarted = false;
    const deleting = coordinator.beginDelete('user-a').then(finish => {
      deleteStarted = true;
      finish();
    });
    await Promise.resolve();
    expect(deleteStarted).toBe(false);

    settleUnderlying('done');
    await expect(tracked).resolves.toBe('done');
    await deleting;
    expect(deleteStarted).toBe(true);
    expect(coordinator.size()).toBe(0);
  });

  test('background destruction waits for an active tab publication operation', async () => {
    const coordinator = createSessionOperationCoordinator();
    const finishTabPublication = coordinator.enter('user-a');
    const destroy = jest.fn(async () => 'destroyed');
    const destruction = runCoordinatedDeletion(coordinator, 'user-a', destroy);

    await nextTurn();
    expect(destroy).not.toHaveBeenCalled();
    expect(() => coordinator.enter('user-a')).toThrow(expect.objectContaining({
      code: 'session_deletion_inflight',
    }));

    finishTabPublication();
    await expect(destruction).resolves.toBe('destroyed');
    expect(destroy).toHaveBeenCalledTimes(1);
    const finishNext = coordinator.enter('user-a');
    finishNext();
  });

  test('cancels a pending deletion reservation when its response already closed', () => {
    const response = new EventEmitter();
    response.destroyed = true;
    response.writableEnded = false;
    response.end = jest.fn();
    const finish = jest.fn();

    expect(attachOperationCompletion(response, finish)).toBe(false);
    expect(finish).toHaveBeenCalledTimes(1);
    expect(response.end).not.toHaveBeenCalled();
  });
});
