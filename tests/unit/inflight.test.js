import { coalesceInflight } from '../../lib/inflight.js';

describe('coalesceInflight', () => {
  test('concurrent calls for the same key invoke the factory once', async () => {
    const map = new Map();
    let calls = 0;
    const factory = async () => {
      calls += 1;
      await new Promise((r) => setTimeout(r, 10));
      return { id: calls };
    };

    const [a, b, c] = await Promise.all([
      coalesceInflight(map, 'user-1', factory),
      coalesceInflight(map, 'user-1', factory),
      coalesceInflight(map, 'user-1', factory),
    ]);

    expect(calls).toBe(1);
    expect(a).toBe(b);
    expect(b).toBe(c);
  });

  test('different keys run independently', async () => {
    const map = new Map();
    const factoryFor = (label) => async () => {
      await new Promise((r) => setTimeout(r, 5));
      return label;
    };

    const [a, b] = await Promise.all([
      coalesceInflight(map, 'user-a', factoryFor('A')),
      coalesceInflight(map, 'user-b', factoryFor('B')),
    ]);

    expect(a).toBe('A');
    expect(b).toBe('B');
  });

  test('map entry is cleared after resolve, so a later call creates fresh', async () => {
    const map = new Map();
    let calls = 0;
    const factory = async () => ({ id: ++calls });

    const first = await coalesceInflight(map, 'user-1', factory);
    expect(map.has('user-1')).toBe(false);

    const second = await coalesceInflight(map, 'user-1', factory);
    expect(map.has('user-1')).toBe(false);

    expect(calls).toBe(2);
    expect(first).not.toBe(second);
  });

  test('map entry is cleared after reject and the rejection propagates to all awaiters', async () => {
    const map = new Map();
    const factory = async () => {
      await new Promise((r) => setTimeout(r, 5));
      throw new Error('boom');
    };

    const first = coalesceInflight(map, 'user-1', factory);
    const second = coalesceInflight(map, 'user-1', factory);

    await expect(first).rejects.toThrow('boom');
    await expect(second).rejects.toThrow('boom');
    expect(map.has('user-1')).toBe(false);
  });
});
