/**
 * Shared auth middleware for camofox-browser.
 *
 * Extracts the duplicated auth pattern from cookie/storage_state endpoints
 * into a reusable Express middleware factory.
 *
 * Policy:
 *   - If CAMOFOX_API_KEY is set, require Bearer token match (timing-safe).
 *   - If not set and NODE_ENV !== production, allow loopback (127.0.0.1 / ::1).
 *   - Otherwise, reject.
 */

import crypto from 'crypto';

/**
 * Timing-safe string comparison.
 */
function timingSafeCompare(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) {
    // Compare against self to burn constant time, then return false
    crypto.timingSafeEqual(bufA, bufA);
    return false;
  }
  return crypto.timingSafeEqual(bufA, bufB);
}

/**
 * Check if an address is loopback.
 */
function isLoopbackAddress(address) {
  if (!address) return false;
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1';
}

/**
 * Create an Express middleware that enforces API key auth.
 *
 * @param {object} config - Must have { apiKey, nodeEnv }
 * @param {object} [options]
 * @param {string} [options.errorMessage] - Custom error message when rejecting unauthenticated requests
 * @returns {function} Express middleware (req, res, next)
 */
export function requireAuth(config, options = {}) {
  const errorMessage = options.errorMessage ||
    'This endpoint requires CAMOFOX_API_KEY except for loopback requests in non-production environments.';

  return (req, res, next) => {
    if (config.apiKey) {
      const auth = String(req.headers['authorization'] || '');
      const match = auth.match(/^Bearer\s+(.+)$/i);
      if (!match || !timingSafeCompare(match[1], config.apiKey)) {
        return res.status(403).json({ error: 'Forbidden' });
      }
      return next();
    }

    const remoteAddress = req.socket?.remoteAddress || '';
    const allowUnauthedLocal = config.nodeEnv !== 'production' && isLoopbackAddress(remoteAddress);
    if (!allowUnauthedLocal) {
      return res.status(403).json({ error: errorMessage });
    }

    next();
  };
}

// Re-export utilities so server.js can still use them directly
export { timingSafeCompare, isLoopbackAddress };
