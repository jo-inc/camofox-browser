import { describe, test, expect } from '@jest/globals';
import {
  parseWheelParams,
  resolveViewportCenter,
  validateRange,
} from '../../lib/interaction-params.js';

// Guards for /tabs/:tabId/mouse-wheel. The endpoint imports these same
// functions, so there is no copy to drift.

describe('validateRange', () => {
  const range = { min: 100, max: 60000, default: 15000 };

  test('falls back to the default when absent', () => {
    expect(validateRange('durationMs', undefined, range)).toEqual({ ok: true, value: 15000 });
    expect(validateRange('durationMs', null, range)).toEqual({ ok: true, value: 15000 });
  });

  test('accepts an in-range number', () => {
    expect(validateRange('durationMs', 100, range)).toEqual({ ok: true, value: 100 });
    expect(validateRange('durationMs', 60000, range)).toEqual({ ok: true, value: 60000 });
  });

  test.each([['NaN', NaN], ['Infinity', Infinity], ['string', '5000'], ['object', {}]])(
    'rejects %s as non-finite',
    (_label, value) => {
      const result = validateRange('durationMs', value, range);
      expect(result.ok).toBe(false);
      expect(result.error).toMatch(/finite number/i);
    }
  );

  test('rejects out-of-range instead of clamping', () => {
    const tooBig = validateRange('durationMs', 600000, range);
    expect(tooBig.ok).toBe(false);
    expect(tooBig.error).toBe('durationMs out of range (100..60000)');
    expect(validateRange('durationMs', 0, range).ok).toBe(false);
    expect(validateRange('durationMs', -1, range).ok).toBe(false);
  });
});

describe('parseWheelParams', () => {
  test('accepts a ref with a vertical delta', () => {
    const result = parseWheelParams({ ref: 'e22', deltaY: 500 });
    expect(result.ok).toBe(true);
    expect(result.params).toEqual({ ref: 'e22', coords: null, deltaX: 0, deltaY: 500 });
  });

  test('accepts explicit coordinates', () => {
    const result = parseWheelParams({ x: 100, y: 200, deltaY: -300 });
    expect(result.params.coords).toEqual({ x: 100, y: 200 });
  });

  test('rejects when both deltas are zero or absent', () => {
    expect(parseWheelParams({}).error).toMatch(/at least one must be non-zero/i);
    expect(parseWheelParams({ deltaX: 0, deltaY: 0 }).error).toMatch(/at least one must be non-zero/i);
  });

  test.each([
    ['non-finite deltaY', { deltaY: NaN }, /deltaY must be a finite number/],
    ['string deltaY', { deltaY: '500' }, /deltaY must be a finite number/],
    ['delta out of range', { deltaY: 1e9 }, /deltaY out of range/],
    ['x without y', { x: 10, deltaY: 100 }, /x and y must be provided together/],
    ['y without x', { y: 10, deltaY: 100 }, /x and y must be provided together/],
    ['negative coordinate', { x: -1, y: 10, deltaY: 100 }, /x out of range/],
    ['non-finite coordinate', { x: 10, y: Infinity, deltaY: 100 }, /y must be a finite number/],
    ['empty ref', { ref: '  ', deltaY: 100 }, /ref must be a non-empty string/],
    ['non-string ref', { ref: 22, deltaY: 100 }, /ref must be a non-empty string/],
  ])('rejects %s', (_label, body, expected) => {
    const result = parseWheelParams(body);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(expected);
  });
});

describe('resolveViewportCenter', () => {
  test('halves a fixed viewport without touching the page', async () => {
    let evaluated = false;
    const page = {
      viewportSize: () => ({ width: 1280, height: 720 }),
      evaluate: async () => {
        evaluated = true;
        return { width: 1, height: 1 };
      },
    };
    await expect(resolveViewportCenter(page)).resolves.toEqual({ x: 640, y: 360 });
    expect(evaluated).toBe(false);
  });

  test('falls back to the page view when viewportSize() is null', async () => {
    // Camoufox launches with no fixed viewport, so viewportSize() is null and
    // the pre-fix code threw "Cannot read properties of null (reading width)",
    // surfacing as a 500 on every wheel call without a ref or coords.
    const page = {
      viewportSize: () => null,
      evaluate: async () => ({ width: 1000, height: 500 }),
    };
    await expect(resolveViewportCenter(page)).resolves.toEqual({ x: 500, y: 250 });
  });

  test('rejects with 422 when neither source yields usable numbers', async () => {
    const page = {
      viewportSize: () => null,
      evaluate: async () => ({ width: null, height: undefined }),
    };
    await expect(resolveViewportCenter(page)).rejects.toMatchObject({ statusCode: 422 });
  });
});
