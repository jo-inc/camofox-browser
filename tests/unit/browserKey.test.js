import { describe, expect, test } from '@jest/globals';
import { normalizeBrowserKey } from '../../lib/browser-key.js';

describe('normalizeBrowserKey', () => {
  test('normalizes common modifier aliases in keyboard chords', () => {
    expect(normalizeBrowserKey('CTRL+A')).toBe('Control+A');
    expect(normalizeBrowserKey('META+A')).toBe('Meta+A');
    expect(normalizeBrowserKey('cmd+option+P')).toBe('Meta+Alt+P');
  });

  test('normalizes named keys case-insensitively', () => {
    expect(normalizeBrowserKey('Enter')).toBe('Enter');
    expect(normalizeBrowserKey('ENTER')).toBe('Enter');
    expect(normalizeBrowserKey('TAB')).toBe('Tab');
    expect(normalizeBrowserKey('END')).toBe('End');
    expect(normalizeBrowserKey('ARROWDOWN')).toBe('ArrowDown');
    expect(normalizeBrowserKey('ctrl+ARROWLEFT')).toBe('Control+ArrowLeft');
  });
});
