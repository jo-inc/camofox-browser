import { describe, test, expect } from '@jest/globals';
import { createKeepAlive, parseKeepaliveUsers, validKeepaliveMinutes } from '../../lib/keepalive.js';

describe('keep-alive', () => {
  test('parses the standing userIds from a comma-separated list', () => {
    expect(parseKeepaliveUsers(' alice, ,bob ')).toEqual(['alice', 'bob']);
    expect(parseKeepaliveUsers(undefined)).toEqual([]);
  });

  test('a standing userId is always kept, and ending it changes nothing', () => {
    const keep = createKeepAlive(['alice']);
    expect(keep.isKeptAlive('alice', 0)).toBe(true);
    expect(keep.end('alice')).toBe(false);
    expect(keep.isKeptAlive('alice', 10 ** 12)).toBe(true);
    expect(keep.isKeptAlive('bob', 0)).toBe(false);
  });

  test('a temporary keep-alive lasts until its deadline', () => {
    const keep = createKeepAlive();
    const until = keep.keep('bob', 10, 1_000);
    expect(until).toBe(1_000 + 10 * 60_000);
    expect(keep.isKeptAlive('bob', until - 1)).toBe(true);
    expect(keep.isKeptAlive('bob', until)).toBe(false);
    expect(keep.end('bob')).toBe(false);
  });

  test('ending a keep-alive lets the userId expire again', () => {
    const keep = createKeepAlive();
    keep.keep('bob', 10, 0);
    expect(keep.end('bob')).toBe(true);
    expect(keep.isKeptAlive('bob', 1)).toBe(false);
  });

  test('minutes must be a number above 0 and at most a day', () => {
    expect(validKeepaliveMinutes(1)).toBe(true);
    expect(validKeepaliveMinutes(1440)).toBe(true);
    for (const bad of [0, -1, 1441, '10', null, Number.NaN]) expect(validKeepaliveMinutes(bad)).toBe(false);
  });
});
