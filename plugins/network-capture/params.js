/**
 * Client-input validation for /tabs/:tabId/capture-network and
 * /tabs/:tabId/capture-requests.
 *
 * Both routes take a user-supplied regular expression and numeric limits. Every
 * invalid value must surface as a 400 with an actionable message, never as an
 * internal error: `new RegExp(userInput)` throws a SyntaxError that would
 * otherwise become a 500, and out-of-range durations/limits would either
 * silently clamp or blow the handler budget.
 */

import { validateRange } from '../../lib/interaction-params.js';

export const MAX_URL_PATTERN_LENGTH = 200;

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
