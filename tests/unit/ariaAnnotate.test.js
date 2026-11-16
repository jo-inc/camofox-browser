import { describe, test, expect } from '@jest/globals';
import {
  SKIP_PATTERNS,
  normalizedAccessibleName,
  annotateAriaSnapshotRefs,
} from '../../lib/aria-annotate.js';

describe('normalizedAccessibleName', () => {
  test('collapses whitespace, trims, lowercases', () => {
    expect(normalizedAccessibleName('  Sign   In  ')).toBe('sign in');
  });
  test('handles null/undefined', () => {
    expect(normalizedAccessibleName(undefined)).toBe('');
    expect(normalizedAccessibleName(null)).toBe('');
  });
});

describe('annotateAriaSnapshotRefs', () => {
  test('returns input unchanged when no refs', () => {
    const yaml = '- button "Go"';
    expect(annotateAriaSnapshotRefs(yaml, new Map())).toBe(yaml);
    expect(annotateAriaSnapshotRefs('', new Map())).toBe('');
  });

  test('annotates an interactive row that matches a ref', () => {
    const yaml = '- heading "Welcome"\n- button "Submit"';
    const refs = new Map([['e1', { role: 'button', name: 'Submit', nth: 0 }]]);
    const out = annotateAriaSnapshotRefs(yaml, refs);
    expect(out).toContain('- button "Submit" [e1]');
    // non-interactive heading row left alone
    expect(out).toContain('- heading "Welcome"');
  });

  test('disambiguates repeated role+name by nth', () => {
    const yaml = '- link "Open"\n- link "Open"';
    const refs = new Map([
      ['e1', { role: 'link', name: 'Open', nth: 0 }],
      ['e2', { role: 'link', name: 'Open', nth: 1 }],
    ]);
    const out = annotateAriaSnapshotRefs(yaml, refs).split('\n');
    expect(out[0]).toBe('- link "Open" [e1]');
    expect(out[1]).toBe('- link "Open" [e2]');
  });

  test('skips date-picker / calendar noise rows', () => {
    const yaml = '- button "Calendar"';
    const refs = new Map([['e1', { role: 'button', name: 'Calendar', nth: 0 }]]);
    expect(annotateAriaSnapshotRefs(yaml, refs)).toBe(yaml);
    expect(SKIP_PATTERNS.some(p => p.test('Calendar'))).toBe(true);
  });

  test('does not annotate non-interactive roles', () => {
    const yaml = '- paragraph "hello"';
    const refs = new Map([['e1', { role: 'paragraph', name: 'hello', nth: 0 }]]);
    expect(annotateAriaSnapshotRefs(yaml, refs)).toBe(yaml);
  });
});
