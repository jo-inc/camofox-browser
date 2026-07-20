import { describe, expect, test } from '@jest/globals';
import { browserProcessNameRssMb } from '../../lib/resources.js';

describe('browserProcessNameRssMb', () => {
  test('returns null on non-linux platforms or no browser processes', () => {
    const value = browserProcessNameRssMb();
    expect(value === null || Number.isInteger(value)).toBe(true);
  });
});
