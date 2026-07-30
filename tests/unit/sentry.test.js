import { sanitizeRequestPath } from '../../lib/sentry.js';

describe('sanitizeRequestPath', () => {
  test('drops query strings before telemetry capture', () => {
    expect(sanitizeRequestPath({
      path: '/tabs',
      originalUrl: '/tabs?sessionOwnerToken=must-not-leak&userId=example',
    })).toBe('/tabs');
  });

  test('falls back to an original URL pathname without query data', () => {
    expect(sanitizeRequestPath({ originalUrl: '/broken?secret=must-not-leak' })).toBe('/broken');
  });
});
