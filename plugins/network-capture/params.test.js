import { describe, test, expect } from '@jest/globals';
import {
  compileUrlPattern,
  hasNestedQuantifier,
  parseCaptureParams,
  MAX_URL_PATTERN_LENGTH,
} from './params.js';

// Guards for /capture-network and /capture-requests. The routes import these
// same functions, so there is no copy to drift.

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
