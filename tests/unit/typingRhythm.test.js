/**
 * Tests for keyboard-mode key timing (lib/typing-rhythm.js).
 *
 * Playwright's keyboard.type(text, { delay }) holds every key for exactly
 * `delay` ms. With the old fixed 30 ms default the rhythm was exactly even,
 * which is a sign of automation. Without an explicit delay, each key is now
 * held for a random 15-45 ms (same 30 ms average, same total time); an
 * explicit delay is passed through unchanged.
 */
import { describe, test, expect } from '@jest/globals';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { DEFAULT_KEY_DELAY_MS, jitteredKeyDelay, typeKeys } from '../../lib/typing-rhythm.js';

const serverSrc = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../../server.js'), 'utf8');

describe('keyboard mode key timing', () => {
  function fakeKeyboard() {
    const calls = [];
    return { calls, async type(text, options) { calls.push([text, options]); } };
  }

  test('without a delay, each key is held a random 15-45ms, averaging 30ms', () => {
    expect(DEFAULT_KEY_DELAY_MS).toBe(30);
    expect(jitteredKeyDelay(() => 0)).toBe(15);
    expect(jitteredKeyDelay(() => 0.5)).toBe(30);
    expect(jitteredKeyDelay(() => 0.9999)).toBe(45);
    const seen = new Set();
    let sum = 0;
    const n = 5000;
    for (let i = 0; i < n; i++) {
      const d = jitteredKeyDelay();
      expect(d).toBeGreaterThanOrEqual(15);
      expect(d).toBeLessThanOrEqual(45);
      seen.add(d);
      sum += d;
    }
    expect(seen.size).toBeGreaterThan(20);
    expect(Math.abs(sum / n - 30)).toBeLessThan(1);
  });

  test('without a delay, text is typed one character per call, in order', async () => {
    const kb = fakeKeyboard();
    const rands = [0, 0.5, 0.9999, 0.25];
    await typeKeys(kb, 'añ😀b', undefined, () => rands.shift());
    expect(kb.calls).toEqual([
      ['a', { delay: 15 }],
      ['ñ', { delay: 30 }],
      ['😀', { delay: 45 }],
      ['b', { delay: 23 }],
    ]);
  });

  test('an explicit delay is passed through unchanged', async () => {
    const kb = fakeKeyboard();
    await typeKeys(kb, 'abc', 30);
    await typeKeys(kb, 'xy', 0);
    expect(kb.calls).toEqual([['abc', { delay: 30 }], ['xy', { delay: 0 }]]);
  });

  test('both keyboard-mode sites in server.js use typeKeys with no fixed default', () => {
    expect(serverSrc.split('await typeKeys(tabState.page.keyboard, text, delay);').length - 1).toBe(2);
    expect(serverSrc).not.toContain('keyboard.type(text, { delay })');
    expect(serverSrc).not.toMatch(/mode = 'fill', delay = 30/);
  });
});
