/**
 * Client-input validation for the low-level interaction and capture endpoints
 * (/tabs/:tabId/mouse-wheel, /capture-network, /capture-requests).
 *
 * These routes take user-supplied regular expressions and numeric limits. Every
 * invalid value must surface as a 400 with an actionable message, never as an
 * internal error: `new RegExp(userInput)` throws a SyntaxError that would
 * otherwise reach sendError() as a 500, and out-of-range durations/limits would
 * either silently clamp or blow the handler budget.
 *
 * Validators live here (rather than inline in server.js) so the unit tests
 * exercise the real guards instead of a copy that can drift.
 */

export const MAX_URL_PATTERN_LENGTH = 200;
export const MAX_WHEEL_DELTA = 100000;
export const MAX_WHEEL_COORD = 20000;

export const CAPTURE_DURATION_MS = { min: 100, max: 60000, default: 15000 };
export const CAPTURE_MAX_CAPTURES = { min: 1, max: 500, default: 100 };
export const CAPTURE_MAX_BODY_BYTES = { min: 1024, max: 5000000, default: 1000000 };
// Request post-data is far smaller than a response body, so /capture-requests
// keeps a tighter default. Both stay within CAPTURE_MAX_BODY_BYTES bounds.
export const REQUEST_MAX_BODY_BYTES_DEFAULT = 200000;

function invalid(error, code) {
  return { ok: false, error, code };
}

/**
 * Best-effort catastrophic-backtracking guard: flags a quantified group that is
 * itself quantified, e.g. `(a+)+`, `(.*)*`, `(x{2,}){3,}`. This is a heuristic,
 * not a proof of safety -- it exists so a trivially exponential pattern can't be
 * pushed through page.on('response') for every URL the browser sees.
 */
export function hasNestedQuantifier(pattern) {
  return /\([^()]*(?:[*+]|\{\d+,\d*\})[^()]*\)\s*(?:[*+]|\{\d+,\d*\})/.test(pattern);
}

/**
 * Validate and compile a user-supplied URL filter.
 * @returns {{ok: true, regex: RegExp, urlPattern: string}|{ok: false, error: string, code: string}}
 */
export function compileUrlPattern(urlPattern) {
  if (typeof urlPattern !== 'string' || !urlPattern.trim()) {
    return invalid('urlPattern must be a non-empty string', 'invalid_url_pattern');
  }
  if (urlPattern.length > MAX_URL_PATTERN_LENGTH) {
    return invalid(`urlPattern too long (max ${MAX_URL_PATTERN_LENGTH} characters)`, 'invalid_url_pattern');
  }
  if (hasNestedQuantifier(urlPattern)) {
    return invalid(
      'urlPattern rejected: nested quantifier (e.g. "(a+)+") risks catastrophic backtracking. Rewrite without a quantified group inside a quantifier.',
      'invalid_url_pattern'
    );
  }
  let regex;
  try {
    regex = new RegExp(urlPattern, 'i');
  } catch (e) {
    return invalid(`urlPattern is not a valid regular expression: ${e.message}`, 'invalid_url_pattern');
  }
  return { ok: true, regex, urlPattern };
}

/**
 * Validate an optional numeric client parameter against an inclusive range.
 * Absent (undefined/null) falls back to the default; anything else must be a
 * finite in-range number -- strings, NaN and out-of-range values are rejected
 * rather than coerced or clamped, so a caller asking for durationMs: 600000
 * learns the cap instead of silently getting 60s.
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

function validateOptionalBoolean(name, raw, fallback) {
  if (raw === undefined || raw === null) return { ok: true, value: fallback };
  if (typeof raw !== 'boolean') return invalid(`${name} must be a boolean`, 'invalid_param');
  return { ok: true, value: raw };
}

/**
 * Parse the shared body of /capture-network and /capture-requests.
 * @param {object} body request body
 * @param {object} [opts] per-route defaults (capture-requests keeps smaller bodies)
 * @returns {{ok: true, params: object}|{ok: false, error: string, code: string}}
 */
export function parseCaptureParams(body = {}, opts = {}) {
  const { maxBodyBytesDefault = CAPTURE_MAX_BODY_BYTES.default } = opts;

  const pattern = compileUrlPattern(body.urlPattern === undefined ? 'graphql' : body.urlPattern);
  if (!pattern.ok) return pattern;

  const duration = validateRange('durationMs', body.durationMs, CAPTURE_DURATION_MS);
  if (!duration.ok) return duration;

  const maxCaptures = validateRange('maxCaptures', body.maxCaptures, CAPTURE_MAX_CAPTURES);
  if (!maxCaptures.ok) return maxCaptures;

  const maxBodyBytes = validateRange('maxBodyBytes', body.maxBodyBytes, {
    ...CAPTURE_MAX_BODY_BYTES,
    default: maxBodyBytesDefault,
  });
  if (!maxBodyBytes.ok) return maxBodyBytes;

  const includeHeaders = validateOptionalBoolean('includeHeaders', body.includeHeaders, true);
  if (!includeHeaders.ok) return includeHeaders;

  return {
    ok: true,
    params: {
      urlPattern: pattern.urlPattern,
      regex: pattern.regex,
      durationMs: duration.value,
      maxCaptures: maxCaptures.value,
      maxBodyBytes: maxBodyBytes.value,
      includeHeaders: includeHeaders.value,
    },
  };
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
