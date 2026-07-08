/**
 * Tests for validateUrl (navigation/tab-create URL guard).
 *
 * Regression: the guard rejected `about:blank`, which is what clients request
 * to open a fresh blank tab. When an agent's tab closed, its reopen 400'd and
 * it could never recover a working surface (live: cryptids stuck after being
 * told to stop). about:blank must be allowed; dangerous schemes must not.
 */
import { describe, test, expect } from '@jest/globals';
import { validateUrl } from '../../lib/request-utils.js';

describe('validateUrl', () => {
  test('allows about:blank (canonical empty tab — the recovery path)', () => {
    expect(validateUrl('about:blank')).toBeNull();
  });

  test('allows http and https', () => {
    expect(validateUrl('http://example.com')).toBeNull();
    expect(validateUrl('https://web.telegram.org/a/')).toBeNull();
  });

  test('still blocks dangerous non-http(s) schemes', () => {
    expect(validateUrl('file:///etc/passwd')).toMatch(/Blocked URL scheme: file:/);
    expect(validateUrl('chrome://settings')).toMatch(/Blocked URL scheme: chrome:/);
    expect(validateUrl('data:text/html,<script>alert(1)</script>')).toMatch(/Blocked URL scheme: data:/);
  });

  test('does not treat other about: URLs as the blank allowance', () => {
    expect(validateUrl('about:config')).toMatch(/Blocked URL scheme: about:/);
  });

  test('rejects unparseable input', () => {
    expect(validateUrl('not a url')).toMatch(/Invalid URL/);
  });
});
