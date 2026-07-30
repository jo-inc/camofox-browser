import crypto from 'crypto';
import { performance } from 'perf_hooks';

const OWNER_TOKEN_PATTERN = /^[A-Za-z0-9_-]{32,256}$/;
const DEFAULT_TTL_MS = 30 * 60 * 1000;
const DEFAULT_MAX_CLAIMS = 1000;

function ownershipError(message, statusCode, code) {
  return Object.assign(new Error(message), { statusCode, code });
}

function tokenDigest(token) {
  return crypto.createHash('sha256').update(token, 'utf8').digest();
}

function validOwnerToken(token) {
  return typeof token === 'string' && OWNER_TOKEN_PATTERN.test(token);
}

function sameToken(claim, token) {
  if (!validOwnerToken(token)) return false;
  return crypto.timingSafeEqual(claim.digest, tokenDigest(token));
}

export function createSessionOwnershipRegistry({
  ttlMs = DEFAULT_TTL_MS,
  maxClaims = DEFAULT_MAX_CLAIMS,
  now = () => performance.now(),
} = {}) {
  if (!Number.isFinite(ttlMs) || ttlMs <= 0) {
    throw new TypeError('ttlMs must be positive');
  }
  if (!Number.isSafeInteger(maxClaims) || maxClaims <= 0) {
    throw new TypeError('maxClaims must be a positive safe integer');
  }

  const claims = new Map();

  function purgeExpired(canRelease) {
    if (typeof canRelease !== 'function') {
      throw new TypeError('canRelease must be a function');
    }
    const current = now();
    let released = 0;
    for (const [userId, claim] of claims) {
      if (claim.expiresAt <= current && canRelease(userId)) {
        claims.delete(userId);
        released += 1;
      }
    }
    return released;
  }

  function claim(userId, ownerToken, { sessionExists, creationInflight }) {
    if (!validOwnerToken(ownerToken)) {
      throw ownershipError('Invalid session owner token', 400, 'invalid_session_owner_token');
    }
    const current = now();
    if (sessionExists || creationInflight || claims.has(userId)) {
      throw ownershipError('Session is not available for exclusive ownership', 409, 'session_ownership_conflict');
    }
    if (claims.size >= maxClaims) {
      throw ownershipError('Session ownership capacity reached', 503, 'session_ownership_capacity');
    }
    claims.set(userId, {
      digest: tokenDigest(ownerToken),
      expiresAt: current + ttlMs,
    });
  }

  function authorize(userId, ownerToken) {
    if (ownerToken !== undefined && !validOwnerToken(ownerToken)) {
      throw ownershipError('Invalid session owner token', 400, 'invalid_session_owner_token');
    }
    const current = now();
    const existing = claims.get(userId);
    if (!existing) return false;
    if (!sameToken(existing, ownerToken)) {
      throw ownershipError('Session owner token mismatch', 403, 'session_owner_mismatch');
    }
    existing.expiresAt = current + ttlMs;
    return true;
  }

  function release(userId, ownerToken) {
    const existing = claims.get(userId);
    if (!existing) return false;
    if (!sameToken(existing, ownerToken)) {
      throw ownershipError('Session owner token mismatch', 403, 'session_owner_mismatch');
    }
    claims.delete(userId);
    return true;
  }

  function prepareRelease(userId, ownerToken, { creationInflight }) {
    const owned = authorize(userId, ownerToken);
    if (creationInflight) {
      throw ownershipError(
        'Session creation is still in flight',
        409,
        'session_creation_inflight',
      );
    }
    return owned;
  }

  function hasClaim(userId) {
    return claims.has(userId);
  }

  return Object.freeze({ authorize, claim, hasClaim, prepareRelease, purgeExpired, release });
}
