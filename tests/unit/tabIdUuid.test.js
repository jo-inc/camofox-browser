'use strict';

/**
 * Tests for tabNotFoundResponse UUID extraction from Fly-prefixed tab IDs.
 */

// Mirrors the extraction logic in server.js tabNotFoundResponse
function extractUuidPart(tabId) {
  if (tabId && tabId.includes('_') && !tabId.slice(0, tabId.indexOf('_')).includes('-')) {
    return tabId.slice(tabId.indexOf('_') + 1);
  }
  return tabId;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

describe('tabNotFoundResponse UUID extraction', () => {
  test('extracts UUID from Fly-prefixed tab ID', () => {
    const tabId = '68341eecdd3168_a1b2c3d4-e5f6-7890-abcd-ef1234567890';
    expect(extractUuidPart(tabId)).toBe('a1b2c3d4-e5f6-7890-abcd-ef1234567890');
    expect(UUID_RE.test(extractUuidPart(tabId))).toBe(true);
  });

  test('returns plain UUID as-is (no prefix)', () => {
    const tabId = 'a1b2c3d4-e5f6-7890-abcd-ef1234567890';
    expect(extractUuidPart(tabId)).toBe(tabId);
    expect(UUID_RE.test(extractUuidPart(tabId))).toBe(true);
  });

  test('does not treat UUID with dashes as prefixed', () => {
    // A bare UUID has dashes in the first segment before any underscore
    const tabId = 'a1b2c3d4-e5f6-7890-abcd-ef1234567890';
    expect(extractUuidPart(tabId)).toBe(tabId);
  });

  test('random garbage does not pass UUID check', () => {
    expect(UUID_RE.test(extractUuidPart('non-existent-tab'))).toBe(false);
    expect(UUID_RE.test(extractUuidPart('foobar'))).toBe(false);
  });

  test('Fly-prefixed with invalid UUID portion fails check', () => {
    const tabId = '68341eecdd3168_not-a-uuid';
    expect(UUID_RE.test(extractUuidPart(tabId))).toBe(false);
  });
});
