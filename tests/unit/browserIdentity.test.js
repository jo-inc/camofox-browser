import { describe, expect, test } from '@jest/globals';
import { contextIdentityOptions, launchLocale } from '../../lib/browser-identity.js';

describe('browser identity options', () => {
  test('direct contexts use configured locale and timezone without geolocation permission', () => {
    expect(contextIdentityOptions({
      hasProxy: false,
      locale: 'ru-RU',
      timezoneId: 'Europe/Moscow',
    })).toEqual({
      locale: 'ru-RU',
      timezoneId: 'Europe/Moscow',
    });
  });

  test('proxy contexts preserve GeoIP geolocation permission', () => {
    expect(contextIdentityOptions({
      hasProxy: true,
      locale: 'ru-RU',
      timezoneId: 'Europe/Moscow',
    })).toEqual({ permissions: ['geolocation'] });
  });

  test('launch locale is applied only to direct browser launches', () => {
    expect(launchLocale({ hasProxy: false, locales: 'ru-RU,ru' })).toBe('ru-RU,ru');
    expect(launchLocale({ hasProxy: true, locales: 'ru-RU,ru' })).toBeUndefined();
  });
});
