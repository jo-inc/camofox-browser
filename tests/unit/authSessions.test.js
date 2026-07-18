import {
  authSessionPreset,
  cookieMatchesSuffix,
  normalizeAuthSessionSpec,
  sanitizeAuthSessionCookies,
} from '../../lib/auth-sessions.js';

describe('auth session helpers', () => {
  test('supports amazon as a preset, not as a hardcoded endpoint', () => {
    expect(authSessionPreset('amazon')).toMatchObject({
      name: 'amazon',
      domain: 'amazon.com',
      verifyUrl: 'https://www.amazon.com/gp/css/order-history',
    });
  });

  test('normalizes arbitrary domain auth session specs', () => {
    expect(normalizeAuthSessionSpec({
      name: 'example',
      domain: 'example.com',
      verifyUrl: 'https://account.example.com/home',
    })).toMatchObject({
      name: 'example',
      domain: 'example.com',
      verifyUrl: 'https://account.example.com/home',
    });
  });

  test('rejects verify URLs outside the declared domain', () => {
    expect(() => normalizeAuthSessionSpec({
      domain: 'example.com',
      verifyUrl: 'https://evil.test/home',
    })).toThrow('verifyUrl host must match auth session domain');
  });

  test('matches cookie domains by suffix', () => {
    expect(cookieMatchesSuffix({ domain: '.amazon.com' }, 'amazon.com')).toBe(true);
    expect(cookieMatchesSuffix({ domain: 'www.amazon.com' }, 'amazon.com')).toBe(true);
    expect(cookieMatchesSuffix({ domain: 'notamazon.com' }, 'amazon.com')).toBe(false);
    expect(cookieMatchesSuffix({ domain: 'amazon.com.evil.test' }, 'amazon.com')).toBe(false);
  });

  test('sanitizes domain cookies and strips unknown fields', () => {
    const spec = normalizeAuthSessionSpec({ domain: 'amazon.com' });
    const cookies = sanitizeAuthSessionCookies(spec, [
      {
        name: 'session-id',
        value: 'abc',
        domain: '.amazon.com',
        path: '/',
        secure: true,
        evil: 'nope',
      },
    ]);

    expect(cookies).toEqual([
      {
        name: 'session-id',
        value: 'abc',
        domain: '.amazon.com',
        path: '/',
        secure: true,
      },
    ]);
  });

  test('rejects cookies outside declared domain', () => {
    const spec = normalizeAuthSessionSpec({ domain: 'amazon.com' });
    expect(() => sanitizeAuthSessionCookies(spec, [
      { name: 'sid', value: 'abc', domain: '.facebook.com', path: '/' },
    ])).toThrow('Invalid auth session cookies');
  });
});
