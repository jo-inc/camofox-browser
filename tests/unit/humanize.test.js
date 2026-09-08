/**
 * Executable coverage for the natural mouse glide used by /click (anti-bot):
 * where the cursor is aimed before the click.
 */
import { describe, test, expect } from '@jest/globals';
import { rand, randomPointInBox } from '../../lib/humanize.js';

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

describe('rand', () => {
  test('stays within the requested range', () => {
    for (let i = 0; i < 200; i++) {
      const v = rand(40, 120);
      expect(v).toBeGreaterThanOrEqual(40);
      expect(v).toBeLessThan(120);
    }
  });
});
