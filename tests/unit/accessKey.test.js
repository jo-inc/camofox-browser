/**
 * Tests for accessKeyMiddleware (global access-key gate) and
 * requireAuth interaction with CAMOFOX_ACCESS_KEY (superkey behavior).
 *
 * Uses mock req/res objects — no server spawn needed.
 */
import { describe, test, expect } from '@jest/globals';
import { jest } from '@jest/globals';
import { accessKeyMiddleware, requireAuth } from '../../lib/auth.js';

// --- Helpers ---

function mockReq({ method = 'GET', path = '/', headers = {}, remoteAddress = '10.0.0.1' } = {}) {
  return {
    method,
    path,
    headers,
    socket: { remoteAddress },
  };
}

function mockRes() {
  const res = {
    _status: null,
    _json: null,
    _headers: {},
    status(code) { res._status = code; return res; },
    json(body) { res._json = body; return res; },
    set(key, val) { res._headers[key.toLowerCase()] = val; return res; },
  };
  return res;
}

const ACCESS_KEY = 'ak-test-secret-key-12345';
const API_KEY = 'api-test-secret-key-67890';
const ADMIN_KEY = 'admin-test-secret-key-99999';
const WRONG_KEY = 'wrong-key-nope';

// ────────────────────────────────────────────────────────────────────
// accessKeyMiddleware — global gate
// ────────────────────────────────────────────────────────────────────

describe('accessKeyMiddleware', () => {
  describe('when accessKey is NOT set (backward-compatible)', () => {
    const mw = accessKeyMiddleware({ accessKey: '' });

    test('passes through all requests without Authorization header', () => {
      const req = mockReq({ path: '/tabs' });
      const res = mockRes();
      const next = jest.fn();
      mw(req, res, next);
      expect(next).toHaveBeenCalled();
      expect(res._status).toBeNull();
    });

    test('passes through gated route without header', () => {
      const req = mockReq({ method: 'POST', path: '/tabs' });
      const res = mockRes();
      const next = jest.fn();
      mw(req, res, next);
      expect(next).toHaveBeenCalled();
    });

    test('passes through /health', () => {
      const req = mockReq({ path: '/health' });
      const res = mockRes();
      const next = jest.fn();
      mw(req, res, next);
      expect(next).toHaveBeenCalled();
    });
  });

  describe('when accessKey IS set', () => {
    const mw = accessKeyMiddleware({ accessKey: ACCESS_KEY, apiKey: API_KEY, adminKey: ADMIN_KEY });

    // --- Exemptions ---

    test('exempts GET /health (Docker/Fly healthcheck)', () => {
      const req = mockReq({ path: '/health' });
      const res = mockRes();
      const next = jest.fn();
      mw(req, res, next);
      expect(next).toHaveBeenCalled();
      expect(res._status).toBeNull();
    });

    test('exempts POST /sessions/:userId/cookies when apiKey is set', () => {
      const req = mockReq({ method: 'POST', path: '/sessions/user123/cookies' });
      const res = mockRes();
      const next = jest.fn();
      mw(req, res, next);
      expect(next).toHaveBeenCalled();
    });

    test('exempts POST /stop when adminKey is set', () => {
      const req = mockReq({ method: 'POST', path: '/stop' });
      const res = mockRes();
      const next = jest.fn();
      mw(req, res, next);
      expect(next).toHaveBeenCalled();
    });

    test('does NOT exempt GET /sessions/:userId/cookies (only POST is exempt)', () => {
      const req = mockReq({ method: 'GET', path: '/sessions/user123/cookies' });
      const res = mockRes();
      const next = jest.fn();
      mw(req, res, next);
      expect(next).not.toHaveBeenCalled();
      expect(res._status).toBe(401);
    });

    test('does NOT exempt GET /stop (only POST is exempt)', () => {
      const req = mockReq({ method: 'GET', path: '/stop' });
      const res = mockRes();
      const next = jest.fn();
      mw(req, res, next);
      expect(next).not.toHaveBeenCalled();
      expect(res._status).toBe(401);
    });

    // --- Rejection cases ---

    test('rejects request with no Authorization header → 401', () => {
      const req = mockReq({ method: 'POST', path: '/tabs' });
      const res = mockRes();
      const next = jest.fn();
      mw(req, res, next);
      expect(next).not.toHaveBeenCalled();
      expect(res._status).toBe(401);
      expect(res._json).toEqual({ error: 'Unauthorized' });
    });

    test('includes WWW-Authenticate header on 401', () => {
      const req = mockReq({ method: 'POST', path: '/tabs' });
      const res = mockRes();
      const next = jest.fn();
      mw(req, res, next);
      expect(res._headers['www-authenticate']).toBe('Bearer realm="camofox"');
    });

    test('rejects request with wrong bearer token → 401', () => {
      const req = mockReq({
        method: 'POST',
        path: '/tabs',
        headers: { authorization: `Bearer ${WRONG_KEY}` },
      });
      const res = mockRes();
      const next = jest.fn();
      mw(req, res, next);
      expect(next).not.toHaveBeenCalled();
      expect(res._status).toBe(401);
    });

    test('rejects request with empty bearer token → 401', () => {
      const req = mockReq({
        path: '/tabs',
        headers: { authorization: 'Bearer ' },
      });
      const res = mockRes();
      const next = jest.fn();
      mw(req, res, next);
      expect(next).not.toHaveBeenCalled();
      expect(res._status).toBe(401);
    });

    test('rejects Basic auth scheme → 401', () => {
      const req = mockReq({
        path: '/tabs',
        headers: { authorization: `Basic ${ACCESS_KEY}` },
      });
      const res = mockRes();
      const next = jest.fn();
      mw(req, res, next);
      expect(next).not.toHaveBeenCalled();
      expect(res._status).toBe(401);
    });

    // --- Happy path ---

    test('allows request with valid bearer token', () => {
      const req = mockReq({
        method: 'POST',
        path: '/tabs',
        headers: { authorization: `Bearer ${ACCESS_KEY}` },
      });
      const res = mockRes();
      const next = jest.fn();
      mw(req, res, next);
      expect(next).toHaveBeenCalled();
      expect(res._status).toBeNull();
    });

    test('allows GET request with valid bearer token', () => {
      const req = mockReq({
        path: '/tabs/abc123/snapshot',
        headers: { authorization: `Bearer ${ACCESS_KEY}` },
      });
      const res = mockRes();
      const next = jest.fn();
      mw(req, res, next);
      expect(next).toHaveBeenCalled();
    });

    test('allows DELETE request with valid bearer token', () => {
      const req = mockReq({
        method: 'DELETE',
        path: '/tabs/abc123',
        headers: { authorization: `Bearer ${ACCESS_KEY}` },
      });
      const res = mockRes();
      const next = jest.fn();
      mw(req, res, next);
      expect(next).toHaveBeenCalled();
    });

    test('bearer prefix is case-insensitive', () => {
      const req = mockReq({
        path: '/tabs',
        headers: { authorization: `bearer ${ACCESS_KEY}` },
      });
      const res = mockRes();
      const next = jest.fn();
      mw(req, res, next);
      expect(next).toHaveBeenCalled();
    });

    test('trims trailing whitespace from bearer token', () => {
      const req = mockReq({
        path: '/tabs',
        headers: { authorization: `Bearer ${ACCESS_KEY}  ` },
      });
      const res = mockRes();
      const next = jest.fn();
      mw(req, res, next);
      expect(next).toHaveBeenCalled();
    });

    // --- Route coverage ---

    test('gates /tabs/:tabId/evaluate (arbitrary JS execution)', () => {
      const req = mockReq({ method: 'POST', path: '/tabs/t1/evaluate' });
      const res = mockRes();
      const next = jest.fn();
      mw(req, res, next);
      expect(next).not.toHaveBeenCalled();
      expect(res._status).toBe(401);
    });

    test('gates /metrics', () => {
      const req = mockReq({ path: '/metrics' });
      const res = mockRes();
      const next = jest.fn();
      mw(req, res, next);
      expect(next).not.toHaveBeenCalled();
      expect(res._status).toBe(401);
    });

    test('gates /openapi.json', () => {
      const req = mockReq({ path: '/openapi.json' });
      const res = mockRes();
      const next = jest.fn();
      mw(req, res, next);
      expect(next).not.toHaveBeenCalled();
      expect(res._status).toBe(401);
    });

    test('gates / (root)', () => {
      const req = mockReq({ path: '/' });
      const res = mockRes();
      const next = jest.fn();
      mw(req, res, next);
      expect(next).not.toHaveBeenCalled();
      expect(res._status).toBe(401);
    });

    test('gates DELETE /sessions/:userId', () => {
      const req = mockReq({ method: 'DELETE', path: '/sessions/user1' });
      const res = mockRes();
      const next = jest.fn();
      mw(req, res, next);
      expect(next).not.toHaveBeenCalled();
      expect(res._status).toBe(401);
    });

    test('gates legacy POST /navigate', () => {
      const req = mockReq({ method: 'POST', path: '/navigate' });
      const res = mockRes();
      const next = jest.fn();
      mw(req, res, next);
      expect(next).not.toHaveBeenCalled();
      expect(res._status).toBe(401);
    });
  });

  // --- Defense-in-depth: conditional exemptions ---

  describe('defense-in-depth: exemptions only when dedicated key is set', () => {
    test('does NOT exempt POST /stop when adminKey is NOT set', () => {
      const mw = accessKeyMiddleware({ accessKey: ACCESS_KEY, adminKey: '', apiKey: API_KEY });
      const req = mockReq({ method: 'POST', path: '/stop' });
      const res = mockRes();
      const next = jest.fn();
      mw(req, res, next);
      expect(next).not.toHaveBeenCalled();
      expect(res._status).toBe(401);
    });

    test('does NOT exempt POST /sessions/:userId/cookies when apiKey is NOT set', () => {
      const mw = accessKeyMiddleware({ accessKey: ACCESS_KEY, apiKey: '', adminKey: ADMIN_KEY });
      const req = mockReq({ method: 'POST', path: '/sessions/u1/cookies' });
      const res = mockRes();
      const next = jest.fn();
      mw(req, res, next);
      expect(next).not.toHaveBeenCalled();
      expect(res._status).toBe(401);
    });

    test('POST /stop with access key passes when adminKey is NOT set', () => {
      const mw = accessKeyMiddleware({ accessKey: ACCESS_KEY, adminKey: '', apiKey: API_KEY });
      const req = mockReq({
        method: 'POST',
        path: '/stop',
        headers: { authorization: `Bearer ${ACCESS_KEY}` },
      });
      const res = mockRes();
      const next = jest.fn();
      mw(req, res, next);
      expect(next).toHaveBeenCalled();
    });
  });
});

// ────────────────────────────────────────────────────────────────────
// requireAuth — per-route middleware with access-key superkey behavior
// ────────────────────────────────────────────────────────────────────

describe('requireAuth with accessKey (superkey)', () => {
  describe('both apiKey and accessKey set (double-auth scenario)', () => {
    const config = { apiKey: API_KEY, accessKey: ACCESS_KEY, nodeEnv: 'production' };

    test('accepts API key bearer token', () => {
      const mw = requireAuth(config);
      const req = mockReq({ headers: { authorization: `Bearer ${API_KEY}` } });
      const res = mockRes();
      const next = jest.fn();
      mw(req, res, next);
      expect(next).toHaveBeenCalled();
    });

    test('accepts access key bearer token (superkey)', () => {
      const mw = requireAuth(config);
      const req = mockReq({ headers: { authorization: `Bearer ${ACCESS_KEY}` } });
      const res = mockRes();
      const next = jest.fn();
      mw(req, res, next);
      expect(next).toHaveBeenCalled();
    });

    test('rejects wrong token', () => {
      const mw = requireAuth(config);
      const req = mockReq({ headers: { authorization: `Bearer ${WRONG_KEY}` } });
      const res = mockRes();
      const next = jest.fn();
      mw(req, res, next);
      expect(next).not.toHaveBeenCalled();
      expect(res._status).toBe(403);
    });

    test('rejects missing Authorization header', () => {
      const mw = requireAuth(config);
      const req = mockReq({});
      const res = mockRes();
      const next = jest.fn();
      mw(req, res, next);
      expect(next).not.toHaveBeenCalled();
      expect(res._status).toBe(403);
    });

    test('trims trailing whitespace from bearer token', () => {
      const mw = requireAuth(config);
      const req = mockReq({ headers: { authorization: `Bearer ${API_KEY}   ` } });
      const res = mockRes();
      const next = jest.fn();
      mw(req, res, next);
      expect(next).toHaveBeenCalled();
    });
  });

  describe('only accessKey set (no apiKey)', () => {
    const config = { apiKey: '', accessKey: ACCESS_KEY, nodeEnv: 'production' };

    test('accepts access key bearer token', () => {
      const mw = requireAuth(config);
      const req = mockReq({ headers: { authorization: `Bearer ${ACCESS_KEY}` } });
      const res = mockRes();
      const next = jest.fn();
      mw(req, res, next);
      expect(next).toHaveBeenCalled();
    });

    test('rejects wrong token — does NOT fall through to loopback', () => {
      const mw = requireAuth(config);
      const req = mockReq({
        headers: { authorization: `Bearer ${WRONG_KEY}` },
        remoteAddress: '127.0.0.1',
      });
      const res = mockRes();
      const next = jest.fn();
      mw(req, res, next);
      expect(next).not.toHaveBeenCalled();
      expect(res._status).toBe(403);
    });

    test('rejects loopback without token — accessKey gates even loopback', () => {
      const devConfig = { apiKey: '', accessKey: ACCESS_KEY, nodeEnv: 'development' };
      const mw = requireAuth(devConfig);
      const req = mockReq({ remoteAddress: '127.0.0.1' });
      const res = mockRes();
      const next = jest.fn();
      mw(req, res, next);
      expect(next).not.toHaveBeenCalled();
      expect(res._status).toBe(403);
    });
  });

  describe('only apiKey set (no accessKey — original behavior)', () => {
    const config = { apiKey: API_KEY, accessKey: '', nodeEnv: 'production' };

    test('accepts API key', () => {
      const mw = requireAuth(config);
      const req = mockReq({ headers: { authorization: `Bearer ${API_KEY}` } });
      const res = mockRes();
      const next = jest.fn();
      mw(req, res, next);
      expect(next).toHaveBeenCalled();
    });

    test('rejects wrong key', () => {
      const mw = requireAuth(config);
      const req = mockReq({ headers: { authorization: `Bearer ${WRONG_KEY}` } });
      const res = mockRes();
      const next = jest.fn();
      mw(req, res, next);
      expect(next).not.toHaveBeenCalled();
      expect(res._status).toBe(403);
    });
  });

  describe('neither key set (original loopback behavior)', () => {
    const config = { apiKey: '', accessKey: '', nodeEnv: 'development' };

    test('allows loopback', () => {
      const mw = requireAuth(config);
      const req = mockReq({ remoteAddress: '127.0.0.1' });
      const res = mockRes();
      const next = jest.fn();
      mw(req, res, next);
      expect(next).toHaveBeenCalled();
    });

    test('rejects non-loopback', () => {
      const mw = requireAuth(config);
      const req = mockReq({ remoteAddress: '192.168.1.1' });
      const res = mockRes();
      const next = jest.fn();
      mw(req, res, next);
      expect(next).not.toHaveBeenCalled();
      expect(res._status).toBe(403);
    });
  });
});

// ────────────────────────────────────────────────────────────────────
// End-to-end double-auth simulation
// (accessKeyMiddleware → requireAuth on the same request)
// ────────────────────────────────────────────────────────────────────

describe('double-auth chain (access-key middleware → requireAuth)', () => {
  const config = { apiKey: API_KEY, accessKey: ACCESS_KEY, adminKey: ADMIN_KEY, nodeEnv: 'production' };
  const globalMw = accessKeyMiddleware(config);
  const routeMw = requireAuth(config);

  function runChain(req) {
    const res = mockRes();
    let chainResult = null;
    const globalNext = jest.fn(() => {
      // Simulate Express calling the next middleware (route-level auth)
      routeMw(req, res, jest.fn(() => { chainResult = 'allowed'; }));
    });
    globalMw(req, res, globalNext);
    return { res, chainResult, globalNextCalled: globalNext.mock.calls.length > 0 };
  }

  test('access key passes both middlewares (superkey on trace-like routes)', () => {
    const req = mockReq({
      path: '/sessions/u1/traces',
      headers: { authorization: `Bearer ${ACCESS_KEY}` },
    });
    const { chainResult } = runChain(req);
    expect(chainResult).toBe('allowed');
  });

  test('API key does NOT pass global middleware (different from access key)', () => {
    const req = mockReq({
      path: '/sessions/u1/traces',
      headers: { authorization: `Bearer ${API_KEY}` },
    });
    const { res, globalNextCalled } = runChain(req);
    // Global middleware rejects because API_KEY ≠ ACCESS_KEY
    expect(globalNextCalled).toBe(false);
    expect(res._status).toBe(401);
  });

  test('wrong key fails at global middleware', () => {
    const req = mockReq({
      path: '/sessions/u1/traces',
      headers: { authorization: `Bearer ${WRONG_KEY}` },
    });
    const { res, globalNextCalled } = runChain(req);
    expect(globalNextCalled).toBe(false);
    expect(res._status).toBe(401);
  });

  test('access key on non-trace route passes global then reaches handler', () => {
    const req = mockReq({
      method: 'POST',
      path: '/tabs',
      headers: { authorization: `Bearer ${ACCESS_KEY}` },
    });
    const res = mockRes();
    const next = jest.fn();
    globalMw(req, res, next);
    expect(next).toHaveBeenCalled();
  });
});

// ────────────────────────────────────────────────────────────────────
// Named middleware functions (debuggability)
// ────────────────────────────────────────────────────────────────────

describe('middleware function naming', () => {
  test('accessKeyMiddleware returns named function', () => {
    const mw = accessKeyMiddleware({ accessKey: '' });
    expect(mw.name).toBe('accessKeyCheck');
  });

  test('requireAuth returns named function', () => {
    const mw = requireAuth({ apiKey: '', nodeEnv: 'development' });
    expect(mw.name).toBe('requireAuthCheck');
  });
});
