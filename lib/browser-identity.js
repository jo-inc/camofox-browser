export function contextIdentityOptions({ hasProxy, locale, timezoneId }) {
  if (hasProxy) return { permissions: ['geolocation'] };
  return { locale, timezoneId };
}

export function launchLocale({ hasProxy, locales }) {
  return hasProxy ? undefined : locales;
}
