import { describe, test, expect } from '@jest/globals';
import { isDismissName, selectOverlayTargets, normalizeOverlayName, refsToCandidates } from '../../lib/overlays.js';

describe('overlay dismissal selection (unit)', () => {
  test('refsToCandidates maps a ref Map to candidate records', () => {
    const refs = new Map([
      ['e1', { role: 'button', name: 'Close', nth: 0 }],
      ['e2', { role: 'link', name: 'Home' }],
    ]);
    expect(refsToCandidates(refs)).toEqual([
      { ref: 'e1', role: 'button', name: 'Close' },
      { ref: 'e2', role: 'link', name: 'Home' },
    ]);
  });

  test('refsToCandidates tolerates missing input', () => {
    expect(refsToCandidates(undefined)).toEqual([]);
    expect(refsToCandidates(null)).toEqual([]);
    expect(refsToCandidates(new Map([['e9', null]]))).toEqual([{ ref: 'e9', role: '', name: '' }]);
  });

  test('normalizes whitespace and case', () => {
    expect(normalizeOverlayName('  No   Thanks ')).toBe('no thanks');
    expect(normalizeOverlayName(undefined)).toBe('');
  });

  test('accepts known close labels', () => {
    for (const name of ['Close', 'close dialog', 'Dismiss', 'No thanks', 'Not now', 'Maybe later', 'Skip', '×', '✕']) {
      expect(isDismissName(name)).toBe(true);
    }
  });

  test('rejects consent, purchase, sign-in and submit controls', () => {
    for (const name of [
      'Accept all', 'Allow cookies', 'I agree', 'Sign in', 'Log in', 'Add to cart',
      'Buy now', 'Checkout', 'Subscribe', 'Submit', 'Continue', 'Confirm', 'Download',
      'Close account', 'Yes, delete', 'Next',
    ]) {
      expect(isDismissName(name)).toBe(false);
    }
  });

  test('rejects empty and non-string names', () => {
    expect(isDismissName('')).toBe(false);
    expect(isDismissName(null)).toBe(false);
  });

  test('selects only buttons with safe names', () => {
    const picked = selectOverlayTargets([
      { ref: 'e1', role: 'button', name: 'Accept all' },
      { ref: 'e2', role: 'link', name: 'Close' },
      { ref: 'e3', role: 'button', name: 'Close' },
      { ref: 'e4', role: 'button', name: 'Sign in' },
      { ref: 'e5', role: 'button', name: '×' },
    ]);
    expect(picked.map((c) => c.ref)).toEqual(['e3', 'e5']);
  });

  test('respects the limit and clamps it to 1..5', () => {
    const many = Array.from({ length: 9 }, (_, i) => ({ ref: `e${i}`, role: 'button', name: 'Close' }));
    expect(selectOverlayTargets(many, { limit: 2 })).toHaveLength(2);
    expect(selectOverlayTargets(many, { limit: 50 })).toHaveLength(5);
    expect(selectOverlayTargets(many, { limit: 0 })).toHaveLength(1);
    expect(selectOverlayTargets(many)).toHaveLength(3);
  });

  test('handles missing candidate lists', () => {
    expect(selectOverlayTargets(undefined)).toEqual([]);
    expect(selectOverlayTargets([null, undefined])).toEqual([]);
  });
});
