/**
 * Key timing for keyboard-mode typing.
 *
 * Playwright's keyboard.type(text, { delay }) holds every key for exactly
 * `delay` ms. An exactly even rhythm is a sign of automation, so when the
 * caller gives no delay, each key is held for a random time around the old
 * 30 ms default instead (15-45 ms, same average, same total time).
 * An explicit delay is passed through unchanged.
 */
export const DEFAULT_KEY_DELAY_MS = 30;

export function jitteredKeyDelay(rand = Math.random, meanMs = DEFAULT_KEY_DELAY_MS) {
  return Math.round(meanMs * (0.5 + rand()));
}

export async function typeKeys(keyboard, text, delay, rand = Math.random) {
  if (delay !== undefined) return keyboard.type(text, { delay });
  for (const char of text) {
    await keyboard.type(char, { delay: jitteredKeyDelay(rand) });
  }
}
