/**
 * Client-input validation for the /tabs/:tabId/mouse-wheel endpoint.
 *
 * This route takes user-supplied numeric deltas and optional coordinates. Every
 * invalid value must surface as a 400 with an actionable message, never as an
 * internal error: out-of-range deltas/coords would otherwise either silently
 * clamp or reach sendError() as a 500.
 *
 * Validators live here (rather than inline in server.js) so the unit tests
 * exercise the real guards instead of a copy that can drift.
 */

export const MAX_WHEEL_DELTA = 100000;
export const MAX_WHEEL_COORD = 20000;

function invalid(error, code) {
  return { ok: false, error, code };
}

/**
 * Validate an optional numeric client parameter against an inclusive range.
 * Absent (undefined/null) falls back to the default; anything else must be a
 * finite in-range number -- strings, NaN and out-of-range values are rejected
 * rather than coerced or clamped.
 */
export function validateRange(name, raw, { min, max, default: fallback }) {
  if (raw === undefined || raw === null) return { ok: true, value: fallback };
  if (typeof raw !== 'number' || !Number.isFinite(raw)) {
    return invalid(`${name} must be a finite number`, 'invalid_param');
  }
  if (raw < min || raw > max) {
    return invalid(`${name} out of range (${min}..${max})`, 'invalid_param');
  }
  return { ok: true, value: raw };
}

/**
 * Parse the body of /tabs/:tabId/mouse-wheel.
 * @returns {{ok: true, params: object}|{ok: false, error: string, code: string}}
 */
export function parseWheelParams(body = {}) {
  const { ref, x, y } = body;

  if (ref !== undefined && ref !== null && (typeof ref !== 'string' || !ref.trim())) {
    return invalid('ref must be a non-empty string', 'invalid_param');
  }

  const deltaX = validateRange('deltaX', body.deltaX, { min: -MAX_WHEEL_DELTA, max: MAX_WHEEL_DELTA, default: 0 });
  if (!deltaX.ok) return deltaX;
  const deltaY = validateRange('deltaY', body.deltaY, { min: -MAX_WHEEL_DELTA, max: MAX_WHEEL_DELTA, default: 0 });
  if (!deltaY.ok) return deltaY;
  if (deltaX.value === 0 && deltaY.value === 0) {
    return invalid('deltaX or deltaY required (at least one must be non-zero)', 'invalid_param');
  }

  const hasX = x !== undefined && x !== null;
  const hasY = y !== undefined && y !== null;
  if (hasX !== hasY) {
    return invalid('x and y must be provided together', 'invalid_param');
  }

  let coords = null;
  if (hasX) {
    const vx = validateRange('x', x, { min: 0, max: MAX_WHEEL_COORD, default: 0 });
    if (!vx.ok) return vx;
    const vy = validateRange('y', y, { min: 0, max: MAX_WHEEL_COORD, default: 0 });
    if (!vy.ok) return vy;
    coords = { x: vx.value, y: vy.value };
  }

  return {
    ok: true,
    params: {
      ref: ref ? ref.trim() : null,
      coords,
      deltaX: deltaX.value,
      deltaY: deltaY.value,
    },
  };
}

/**
 * Centre of the page's own view, for a wheel event that names neither a ref
 * nor explicit coordinates.
 *
 * `page.viewportSize()` returns null whenever the browser context was created
 * without a fixed viewport, which is how Camoufox launches: the window is
 * sized by the OS, not by Playwright. Reading `.width` straight off that null
 * throws a TypeError and surfaces as a 500 on an otherwise valid request, so
 * fall back to what the page itself reports.
 */
export async function resolveViewportCenter(page) {
  const size =
    page.viewportSize() ||
    (await page.evaluate(() => ({
      width: window.innerWidth,
      height: window.innerHeight,
    })));

  if (!size || !Number.isFinite(size.width) || !Number.isFinite(size.height)) {
    const err = new Error(
      'Cannot determine a viewport size for the wheel target. Pass x and y explicitly.',
    );
    err.statusCode = 422;
    throw err;
  }

  return { x: size.width / 2, y: size.height / 2 };
}
