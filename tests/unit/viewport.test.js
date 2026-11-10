/**
 * Tests for POST /tabs/:tabId/viewport endpoint validation and behavior.
 */
import { describe, test, expect } from '@jest/globals';

// ============================================================================
// Validation logic (mirrors the guard in server.js)
// ============================================================================

function validateViewport(width, height) {
  if (!Number.isFinite(width) || !Number.isFinite(height) ||
      width < 100 || height < 100 || width > 4000 || height > 4000) {
    return { error: 'width and height required (100..4000 px)' };
  }
  return null;
}

describe('viewport validation', () => {
  test('rejects missing width', () => {
    expect(validateViewport(undefined, 720)).not.toBeNull();
  });

  test('rejects missing height', () => {
    expect(validateViewport(1280, undefined)).not.toBeNull();
  });

  test('rejects string width', () => {
    expect(validateViewport('1280', 720)).not.toBeNull();
  });

  test('rejects string height', () => {
    expect(validateViewport(1280, '720')).not.toBeNull();
  });

  test('rejects width below 100', () => {
    expect(validateViewport(99, 720)).not.toBeNull();
  });

  test('rejects height below 100', () => {
    expect(validateViewport(1280, 99)).not.toBeNull();
  });

  test('rejects width above 4000', () => {
    expect(validateViewport(4001, 720)).not.toBeNull();
  });

  test('rejects height above 4000', () => {
    expect(validateViewport(1280, 4001)).not.toBeNull();
  });

  test('accepts minimum values (100x100)', () => {
    expect(validateViewport(100, 100)).toBeNull();
  });

  test('accepts maximum values (4000x4000)', () => {
    expect(validateViewport(4000, 4000)).toBeNull();
  });

  test('accepts standard desktop viewport (1280x720)', () => {
    expect(validateViewport(1280, 720)).toBeNull();
  });

  test('accepts mobile viewport (375x667)', () => {
    expect(validateViewport(375, 667)).toBeNull();
  });

  test('accepts tablet viewport (768x1024)', () => {
    expect(validateViewport(768, 1024)).toBeNull();
  });

  test('rejects NaN', () => {
    expect(validateViewport(NaN, 720)).not.toBeNull();
  });

  test('rejects Infinity', () => {
    expect(validateViewport(Infinity, 720)).not.toBeNull();
    expect(validateViewport(1280, -Infinity)).not.toBeNull();
  });

  test('rejects null', () => {
    expect(validateViewport(null, null)).not.toBeNull();
  });

  test('accepts floats (will be rounded by endpoint)', () => {
    // The endpoint uses Math.round(), so 1280.5 → 1281
    expect(validateViewport(1280.5, 720.9)).toBeNull();
  });
});

// ============================================================================
// Capability gating (mirrors the shim-flag guard at the top of the route)
// ============================================================================

// Mirror of the first guard inside POST /tabs/:tabId/viewport.
function viewportRouteGate(viewportShimInstalled) {
  if (!viewportShimInstalled) {
    return { status: 501, body: { error: 'viewport control unsupported on this browser build', code: 'viewport_unsupported' } };
  }
  return null; // route proceeds to validation / setViewportSize
}

describe('viewport route capability gating', () => {
  test('returns 501 viewport_unsupported when the shim did not install', () => {
    const res = viewportRouteGate(false);
    expect(res).not.toBeNull();
    expect(res.status).toBe(501);
    expect(res.body.code).toBe('viewport_unsupported');
  });

  test('proceeds (no gate response) when the shim installed', () => {
    expect(viewportRouteGate(true)).toBeNull();
  });
});
