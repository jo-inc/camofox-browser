import { describe, test, expect } from '@jest/globals';
import {
  compileUrlPattern,
  hasNestedQuantifier,
  parseCaptureParams,
  parseWheelParams,
  validateRange,
  MAX_URL_PATTERN_LENGTH,
} from '../../lib/interaction-params.js';

// Guards for /tabs/:tabId/mouse-wheel, /capture-network and /capture-requests.
// The endpoints import these same functions, so there is no copy to drift.

describe('compileUrlPattern', () => {
  test('compiles a valid case-insensitive pattern', () => {
    const result = compileUrlPattern('graphql|/api/v2');
    expect(result.ok).toBe(true);
    expect(result.regex.test('https://x.test/API/V2/list')).toBe(true);
    expect(result.regex.test('https://x.test/static/app.js')).toBe(false);
  });

  test('rejects an invalid regular expression instead of throwing', () => {
    const result = compileUrlPattern('graphql(');
    expect(result.ok).toBe(false);
    expect(result.code).toBe('invalid_url_pattern');
    expect(result.error).toMatch(/not a valid regular expression/i);
  });

  test.each([
    ['empty string', ''],
    ['whitespace only', '   '],
    ['non-string', 42],
    ['null', null],
  ])('rejects %s', (_label, value) => {
    const result = compileUrlPattern(value);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/non-empty string/i);
  });

  test('rejects a pattern longer than the cap', () => {
    const result = compileUrlPattern('a'.repeat(MAX_URL_PATTERN_LENGTH + 1));
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/too long/i);
  });

  test('rejects nested quantifiers that risk catastrophic backtracking', () => {
    for (const pattern of ['(a+)+$', '(.*)*x', '(ab{2,}){3,}']) {
      const result = compileUrlPattern(pattern);
      expect(result.ok).toBe(false);
      expect(result.error).toMatch(/nested quantifier/i);
    }
  });

  test('accepts ordinary alternation and quantifiers', () => {
    for (const pattern of ['(graphql|api)+', 'https://[^/]+/graphql', 'v\\d+/batch']) {
      expect(hasNestedQuantifier(pattern)).toBe(false);
      expect(compileUrlPattern(pattern).ok).toBe(true);
    }
  });
});

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

describe('parseCaptureParams', () => {
  test('applies documented defaults', () => {
    const result = parseCaptureParams({ userId: 'u1' });
    expect(result.ok).toBe(true);
    expect(result.params).toMatchObject({
      urlPattern: 'graphql',
      durationMs: 15000,
      maxCaptures: 100,
      maxBodyBytes: 1000000,
      includeHeaders: true,
    });
  });

  test('honours the per-route maxBodyBytes default', () => {
    const result = parseCaptureParams({ userId: 'u1' }, { maxBodyBytesDefault: 200000 });
    expect(result.params.maxBodyBytes).toBe(200000);
  });

  test.each([
    ['durationMs above cap', { durationMs: 120000 }, /durationMs out of range/],
    ['durationMs below floor', { durationMs: 10 }, /durationMs out of range/],
    ['maxCaptures above cap', { maxCaptures: 5000 }, /maxCaptures out of range/],
    ['maxCaptures zero', { maxCaptures: 0 }, /maxCaptures out of range/],
    ['maxBodyBytes above cap', { maxBodyBytes: 50000000 }, /maxBodyBytes out of range/],
    ['maxBodyBytes as string', { maxBodyBytes: '1000' }, /finite number/],
    ['invalid regex', { urlPattern: '[' }, /not a valid regular expression/],
    ['non-boolean includeHeaders', { includeHeaders: 'yes' }, /must be a boolean/],
  ])('rejects %s', (_label, body, expected) => {
    const result = parseCaptureParams({ userId: 'u1', ...body });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(expected);
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
