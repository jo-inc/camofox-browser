/**
 * Tests for parseNetscapeCookieFile (Netscape cookie format parser).
 *
 * These used to reimplement the parser here, with a comment asking that any
 * change be mirrored by hand. That copy is gone: the tests now import the
 * shipped parser through lib/cookies.js, so a change to the implementation
 * cannot pass while the tests keep exercising an older transcription of it.
 */

import { parseNetscapeCookieFile } from '../../lib/cookies.js';

describe('Netscape cookie file parser', () => {
  test('parses a basic 7-field line', () => {
    const text = '.example.com\tTRUE\t/\tFALSE\t0\tsession_id\tabc123';
    const cookies = parseNetscapeCookieFile(text);
    expect(cookies).toHaveLength(1);
    expect(cookies[0]).toEqual({
      name: 'session_id',
      value: 'abc123',
      domain: '.example.com',
      path: '/',
      expires: -1,
      httpOnly: false,
      secure: false,
    });
  });

  test('parses secure cookie', () => {
    const text = '.example.com\tTRUE\t/\tTRUE\t1700000000\ttoken\txyz';
    const cookies = parseNetscapeCookieFile(text);
    expect(cookies[0].secure).toBe(true);
    expect(cookies[0].expires).toBe(1700000000);
  });

  test('detects #HttpOnly_ prefix', () => {
    const text = '#HttpOnly_.example.com\tTRUE\t/\tTRUE\t0\tsid\tval';
    const cookies = parseNetscapeCookieFile(text);
    expect(cookies).toHaveLength(1);
    expect(cookies[0].httpOnly).toBe(true);
    expect(cookies[0].domain).toBe('.example.com');
  });

  test('skips comment lines', () => {
    const text = [
      '# Netscape HTTP Cookie File',
      '# This is a comment',
      '.example.com\tTRUE\t/\tFALSE\t0\tname\tvalue',
    ].join('\n');
    const cookies = parseNetscapeCookieFile(text);
    expect(cookies).toHaveLength(1);
    expect(cookies[0].name).toBe('name');
  });

  test('skips empty lines', () => {
    const text = [
      '',
      '.example.com\tTRUE\t/\tFALSE\t0\ta\tb',
      '',
      '',
      '.test.com\tFALSE\t/path\tTRUE\t0\tc\td',
      '',
    ].join('\n');
    const cookies = parseNetscapeCookieFile(text);
    expect(cookies).toHaveLength(2);
  });

  test('skips lines with fewer than 7 tab-separated fields', () => {
    const text = [
      '.example.com\tTRUE\t/\tFALSE\t0\tname',
      'too\tfew\tfields',
      '.example.com\tTRUE\t/\tFALSE\t0\tgood\tvalue',
    ].join('\n');
    const cookies = parseNetscapeCookieFile(text);
    expect(cookies).toHaveLength(1);
    expect(cookies[0].name).toBe('good');
  });

  test('handles cookie value containing tabs', () => {
    const text = '.example.com\tTRUE\t/\tFALSE\t0\tname\tval\twith\ttabs';
    const cookies = parseNetscapeCookieFile(text);
    expect(cookies).toHaveLength(1);
    expect(cookies[0].value).toBe('val\twith\ttabs');
  });

  test('handles Windows line endings (\\r\\n)', () => {
    const text = '.a.com\tTRUE\t/\tFALSE\t0\tx\t1\r\n.b.com\tTRUE\t/\tFALSE\t0\ty\t2\r\n';
    const cookies = parseNetscapeCookieFile(text);
    expect(cookies).toHaveLength(2);
    expect(cookies[0].name).toBe('x');
    expect(cookies[1].name).toBe('y');
  });

  test('handles UTF-8 BOM prefix', () => {
    const text = '\uFEFF# Netscape HTTP Cookie File\n.example.com\tTRUE\t/\tFALSE\t0\tname\tvalue';
    const cookies = parseNetscapeCookieFile(text);
    expect(cookies).toHaveLength(1);
    expect(cookies[0].name).toBe('name');
  });

  test('handles BOM before #HttpOnly_ on first line', () => {
    const text = '\uFEFF#HttpOnly_.example.com\tTRUE\t/\tTRUE\t0\tsid\tsecret';
    const cookies = parseNetscapeCookieFile(text);
    expect(cookies).toHaveLength(1);
    expect(cookies[0].httpOnly).toBe(true);
    expect(cookies[0].domain).toBe('.example.com');
  });

  test('treats a session cookie (expires 0) as a session cookie', () => {
    // The whole point of the mapping: 0 is the only way the Netscape format
    // has to say "session", and it is what browser exports actually contain.
    const text = '.example.com\tTRUE\t/\tFALSE\t0\tsid\tval';
    const cookies = parseNetscapeCookieFile(text);
    expect(cookies[0].expires).toBe(-1);
  });

  test('treats a negative expiry as a session cookie', () => {
    const text = '.example.com\tTRUE\t/\tFALSE\t-1\tsid\tval';
    const cookies = parseNetscapeCookieFile(text);
    expect(cookies[0].expires).toBe(-1);
  });

  test('treats an unparsable expiry as a session cookie rather than NaN', () => {
    // Previously this yielded NaN, which addCookies() rejects outright.
    const text = '.example.com\tTRUE\t/\tFALSE\tgarbage\tname\tvalue';
    const cookies = parseNetscapeCookieFile(text);
    expect(cookies).toHaveLength(1);
    expect(cookies[0].expires).toBe(-1);
  });

  test('parses multiple cookies from a real-format file', () => {
    const text = [
      '# Netscape HTTP Cookie File',
      '# https://curl.se/docs/http-cookies.html',
      '',
      '.linkedin.com\tTRUE\t/\tTRUE\t1700000000\tli_at\tAQEDAT...',
      '#HttpOnly_.linkedin.com\tTRUE\t/\tTRUE\t0\tJSESSIONID\tajax:123',
      '.linkedin.com\tTRUE\t/\tFALSE\t1700000000\tlang\tv=2&lang=en-us',
    ].join('\n');
    const cookies = parseNetscapeCookieFile(text);
    expect(cookies).toHaveLength(3);
    expect(cookies[0]).toMatchObject({ name: 'li_at', secure: true, httpOnly: false });
    expect(cookies[1]).toMatchObject({ name: 'JSESSIONID', httpOnly: true, secure: true });
    expect(cookies[2]).toMatchObject({ name: 'lang', secure: false });
  });

  test('returns empty array for empty input', () => {
    expect(parseNetscapeCookieFile('')).toEqual([]);
  });

  test('returns empty array for comments-only file', () => {
    const text = '# comment\n# another comment\n';
    expect(parseNetscapeCookieFile(text)).toEqual([]);
  });

  test('skips lines where trailing tab is trimmed (empty value)', () => {
    // trim() strips the trailing tab, reducing field count to 6 -- line is skipped
    const text = '.example.com\tTRUE\t/\tFALSE\t0\tname\t';
    const cookies = parseNetscapeCookieFile(text);
    expect(cookies).toHaveLength(0);
  });

  test('parses empty value when followed by another line', () => {
    // Empty value with content after -- not just trailing whitespace
    const text = '.example.com\tTRUE\t/\tFALSE\t0\tempty_val\t\n.b.com\tTRUE\t/\tFALSE\t0\tother\tval';
    const cookies = parseNetscapeCookieFile(text);
    // First line: trim strips trailing tab, falls to 6 fields, skipped
    // Second line: normal
    expect(cookies).toHaveLength(1);
    expect(cookies[0].name).toBe('other');
  });
});
