import { jest } from '@jest/globals';
import { closeContextVerified, deleteSessionIfCurrent } from '../../lib/verified-context-close.js';

describe('closeContextVerified', () => {
  test('returns after a successful close', async () => {
    const context = { close: jest.fn().mockResolvedValue(), pages: jest.fn() };
    await expect(closeContextVerified(context)).resolves.toBeUndefined();
    expect(context.pages).not.toHaveBeenCalled();
  });

  test('accepts a close error only when the context proves dead', async () => {
    const closeError = new Error('transport closed');
    const context = {
      close: jest.fn().mockRejectedValue(closeError),
      pages: jest.fn(() => { throw new Error('context closed'); }),
    };
    await expect(closeContextVerified(context)).resolves.toBeUndefined();
  });

  test('fails closed when close throws and the context remains live', async () => {
    const closeError = new Error('close failed');
    const context = {
      close: jest.fn().mockRejectedValue(closeError),
      pages: jest.fn(() => []),
    };
    await expect(closeContextVerified(context)).rejects.toBe(closeError);
  });
});

describe('deleteSessionIfCurrent', () => {
  test('deletes only the exact session that was verified closed', () => {
    const original = { context: {} };
    const sessions = new Map([['user-1', original]]);
    deleteSessionIfCurrent(sessions, 'user-1', original);
    expect(sessions.has('user-1')).toBe(false);
  });

  test('retains a concurrently published replacement and fails closed', () => {
    const original = { context: {} };
    const replacement = { context: {} };
    const sessions = new Map([['user-1', replacement]]);
    expect(() => deleteSessionIfCurrent(sessions, 'user-1', original))
      .toThrow(expect.objectContaining({ code: 'session_replaced_during_close' }));
    expect(sessions.get('user-1')).toBe(replacement);
  });
});
