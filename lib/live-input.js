/**
 * Input rules for the live viewer during a handoff.
 *
 * Pure functions only. The viewer sends small JSON messages describing what the
 * person did. These helpers check each message against a strict allow-list
 * before anything reaches the browser, and cap how fast input can arrive.
 *
 * Typed text is validated here but never logged by callers. Only its length
 * is recorded.
 */

export const LIVE_INPUT_ACTIONS = Object.freeze(['click', 'dblclick', 'type', 'key', 'scroll']);

// Keys a person may press in the live view. Printable characters arrive as
// 'type' messages instead, so they are not in this list.
export const LIVE_INPUT_KEYS = Object.freeze(
  new Set([
    'Enter',
    'Tab',
    'Backspace',
    'Delete',
    'Escape',
    'ArrowUp',
    'ArrowDown',
    'ArrowLeft',
    'ArrowRight',
    'Home',
    'End',
    'PageUp',
    'PageDown',
  ]),
);

export const MAX_TYPED_TEXT_LENGTH = 500;
export const MAX_SCROLL_DELTA = 2000;
export const DEFAULT_VIEWPORT = Object.freeze({ width: 1280, height: 800 });

// Control characters (including newline and tab) are not typed. Keys such as
// Enter and Tab go through the 'key' action instead.
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;

function isUnit(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1;
}

function reject(error) {
  return { ok: false, error };
}

/**
 * @param {unknown} body parsed JSON body from the viewer
 * @returns {{ok: true, action: string, x?: number, y?: number, text?: string, key?: string, deltaY?: number} | {ok: false, error: string}}
 */
export function validateLiveInput(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return reject('body must be a JSON object');
  }
  const { action } = body;
  if (!LIVE_INPUT_ACTIONS.includes(action)) {
    return reject(`action must be one of: ${LIVE_INPUT_ACTIONS.join(', ')}`);
  }

  if (action === 'click' || action === 'dblclick') {
    if (!isUnit(body.x) || !isUnit(body.y)) {
      return reject('x and y must be numbers from 0 to 1');
    }
    return { ok: true, action, x: body.x, y: body.y };
  }

  if (action === 'type') {
    const { text } = body;
    if (typeof text !== 'string' || text.length === 0 || text.length > MAX_TYPED_TEXT_LENGTH) {
      return reject(`text must be 1 to ${MAX_TYPED_TEXT_LENGTH} characters`);
    }
    if (CONTROL_CHARACTERS.test(text)) {
      return reject('text must not contain control characters');
    }
    return { ok: true, action, text };
  }

  if (action === 'key') {
    if (!LIVE_INPUT_KEYS.has(body.key)) {
      return reject('key is not allowed');
    }
    return { ok: true, action, key: body.key };
  }

  // scroll
  const { deltaY } = body;
  if (typeof deltaY !== 'number' || !Number.isFinite(deltaY) || Math.abs(deltaY) > MAX_SCROLL_DELTA) {
    return reject(`deltaY must be a number between -${MAX_SCROLL_DELTA} and ${MAX_SCROLL_DELTA}`);
  }
  return { ok: true, action, deltaY };
}

/**
 * Map a normalized point (0..1 across the displayed image) to a pixel in the
 * page viewport, clamped to the viewport.
 */
export function toViewportPoint(x, y, viewport = DEFAULT_VIEWPORT) {
  const width = Math.max(1, Number(viewport?.width) || DEFAULT_VIEWPORT.width);
  const height = Math.max(1, Number(viewport?.height) || DEFAULT_VIEWPORT.height);
  return {
    x: Math.min(width - 1, Math.max(0, Math.round(x * width))),
    y: Math.min(height - 1, Math.max(0, Math.round(y * height))),
  };
}

/**
 * Sliding-window rate limiter. The clock is injectable for tests.
 *
 * @returns {{take: () => boolean}} take() returns false when the limit is reached
 */
export function createRateLimiter({ limit = 30, windowMs = 1000, now = () => Date.now() } = {}) {
  const hits = [];
  return {
    take() {
      const t = now();
      while (hits.length > 0 && hits[0] <= t - windowMs) hits.shift();
      if (hits.length >= limit) return false;
      hits.push(t);
      return true;
    },
  };
}
