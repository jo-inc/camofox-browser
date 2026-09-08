/**
 * Executable coverage for the natural mouse glide used by /click (anti-bot).
 * Drives the real helpers against a fake Playwright page and asserts the
 * observable path: where the cursor is told to go, and where it lands.
 */
import { describe, test, expect } from '@jest/globals';
import { rand, randomPointInBox, naturalMouseMove } from '../../lib/humanize.js';

function fakePage() {
  const moves = [];
  const waits = [];
  return {
    moves,
    waits,
    mouse: { move: async (x, y) => { moves.push({ x, y }); } },
    waitForTimeout: async ms => { waits.push(ms); }
  };
}

describe('randomPointInBox', () => {
  const box = { x: 100, y: 200, width: 80, height: 40 };

  test('always lands inside the padded interior of the box', () => {
    for (let i = 0; i < 500; i++) {
      const { x, y } = randomPointInBox(box);
      expect(x).toBeGreaterThanOrEqual(box.x + box.width * 0.2);
      expect(x).toBeLessThanOrEqual(box.x + box.width * 0.8);
      expect(y).toBeGreaterThanOrEqual(box.y + box.height * 0.2);
      expect(y).toBeLessThanOrEqual(box.y + box.height * 0.8);
    }
  });

  test('does not collapse to dead center (the bot tell being removed)', () => {
    const cx = box.x + box.width / 2;
    const points = Array.from({ length: 50 }, () => randomPointInBox(box));
    expect(points.some(p => Math.abs(p.x - cx) > 1)).toBe(true);
  });

  test('degenerate zero-size box yields the box origin', () => {
    expect(randomPointInBox({ x: 5, y: 6, width: 0, height: 0 })).toEqual({ x: 5, y: 6 });
  });
});

describe('naturalMouseMove', () => {
  test('walks a multi-segment path and lands exactly on the target', async () => {
    const page = fakePage();
    const landed = await naturalMouseMove(page, { x: 0, y: 0 }, 300, 150, 8);

    expect(landed).toEqual({ x: 300, y: 150 });
    expect(page.moves).toHaveLength(9); // 8 eased steps + exact landing
    expect(page.moves.at(-1)).toEqual({ x: 300, y: 150 });
  });

  test('every intermediate point stays near the start-to-target line (small jitter only)', async () => {
    const page = fakePage();
    await naturalMouseMove(page, { x: 10, y: 10 }, 210, 110, 8);

    for (const { x, y } of page.moves) {
      expect(x).toBeGreaterThanOrEqual(10 - 2);
      expect(x).toBeLessThanOrEqual(210 + 2);
      expect(y).toBeGreaterThanOrEqual(10 - 2);
      expect(y).toBeLessThanOrEqual(110 + 2);
    }
  });

  test('progresses monotonically toward the target (ease-out, no teleport)', async () => {
    const page = fakePage();
    await naturalMouseMove(page, { x: 0, y: 0 }, 1000, 0, 8);

    const xs = page.moves.map(m => m.x);
    expect(xs[0]).toBeLessThan(500); // first hop is a fraction of the distance
    for (let i = 1; i < xs.length; i++) {
      expect(xs[i]).toBeGreaterThan(xs[i - 1] - 3);
    }
  });

  test('pauses a human-variable amount between steps', async () => {
    const page = fakePage();
    await naturalMouseMove(page, { x: 0, y: 0 }, 100, 100, 8);

    expect(page.waits).toHaveLength(8);
    for (const ms of page.waits) {
      expect(ms).toBeGreaterThanOrEqual(8);
      expect(ms).toBeLessThanOrEqual(30);
    }
  });

  test('treats a missing prior cursor position as the origin', async () => {
    const page = fakePage();
    await naturalMouseMove(page, undefined, 50, 50, 4);
    expect(page.moves.at(-1)).toEqual({ x: 50, y: 50 });
  });

  test('propagates page errors instead of silently reporting a move', async () => {
    const page = fakePage();
    page.mouse.move = async () => { throw new Error('Target page closed'); };
    await expect(naturalMouseMove(page, { x: 0, y: 0 }, 10, 10, 4)).rejects.toThrow('Target page closed');
  });
});

describe('rand', () => {
  test('stays within the requested range', () => {
    for (let i = 0; i < 200; i++) {
      const v = rand(40, 120);
      expect(v).toBeGreaterThanOrEqual(40);
      expect(v).toBeLessThan(120);
    }
  });
});
