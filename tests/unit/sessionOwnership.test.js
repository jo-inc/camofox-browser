import { describe, expect, test } from '@jest/globals';

import { createSessionOwnershipRegistry } from '../../lib/session-ownership.js';

const OWNER_A = 'owner_A-0123456789abcdefghijklmnopqrstuvwxyz';
const OWNER_B = 'owner_B-0123456789abcdefghijklmnopqrstuvwxyz';

function expectOwnershipError(action, statusCode, code) {
  try {
    action();
    throw new Error('expected ownership error');
  } catch (error) {
    expect(error.statusCode).toBe(statusCode);
    expect(error.code).toBe(code);
    return error;
  }
}

describe('session ownership registry', () => {
  test('atomically claims only an absent non-inflight session', () => {
    const registry = createSessionOwnershipRegistry();

    registry.claim('temporary-user', OWNER_A, {
      sessionExists: false,
      creationInflight: false,
    });

    expect(registry.hasClaim('temporary-user')).toBe(true);
    expectOwnershipError(
      () => registry.claim('temporary-user', OWNER_B, {
        sessionExists: false,
        creationInflight: false,
      }),
      409,
      'session_ownership_conflict',
    );
    expectOwnershipError(
      () => registry.claim('existing-user', OWNER_A, {
        sessionExists: true,
        creationInflight: false,
      }),
      409,
      'session_ownership_conflict',
    );
    expectOwnershipError(
      () => registry.claim('inflight-user', OWNER_A, {
        sessionExists: false,
        creationInflight: true,
      }),
      409,
      'session_ownership_conflict',
    );
  });

  test('requires a high-entropy opaque owner token', () => {
    const registry = createSessionOwnershipRegistry();

    expectOwnershipError(
      () => registry.claim('temporary-user', 'short', {
        sessionExists: false,
        creationInflight: false,
      }),
      400,
      'invalid_session_owner_token',
    );
    expectOwnershipError(
      () => registry.claim('temporary-user', `${OWNER_A}.invalid`, {
        sessionExists: false,
        creationInflight: false,
      }),
      400,
      'invalid_session_owner_token',
    );
  });

  test('gates claimed sessions while preserving unclaimed compatibility', () => {
    const registry = createSessionOwnershipRegistry();

    expect(registry.authorize('legacy-user', undefined)).toBe(false);
    expectOwnershipError(
      () => registry.authorize('legacy-user', 'short'),
      400,
      'invalid_session_owner_token',
    );
    registry.claim('temporary-user', OWNER_A, {
      sessionExists: false,
      creationInflight: false,
    });

    expect(registry.authorize('temporary-user', OWNER_A)).toBe(true);
    expectOwnershipError(
      () => registry.authorize('temporary-user', OWNER_B),
      403,
      'session_owner_mismatch',
    );
    expectOwnershipError(
      () => registry.authorize('temporary-user', undefined),
      403,
      'session_owner_mismatch',
    );
  });

  test('releases only the exact owned claim', () => {
    const registry = createSessionOwnershipRegistry();
    registry.claim('temporary-user', OWNER_A, {
      sessionExists: false,
      creationInflight: false,
    });

    expectOwnershipError(
      () => registry.release('temporary-user', OWNER_B),
      403,
      'session_owner_mismatch',
    );
    expect(registry.hasClaim('temporary-user')).toBe(true);
    expect(registry.release('temporary-user', OWNER_A)).toBe(true);
    expect(registry.hasClaim('temporary-user')).toBe(false);
    expect(registry.release('temporary-user', OWNER_A)).toBe(false);
  });

  test('does not release ownership while session creation is in flight', () => {
    const registry = createSessionOwnershipRegistry();
    registry.claim('temporary-user', OWNER_A, {
      sessionExists: false,
      creationInflight: false,
    });

    expectOwnershipError(
      () => registry.prepareRelease('temporary-user', OWNER_A, { creationInflight: true }),
      409,
      'session_creation_inflight',
    );
    expectOwnershipError(
      () => registry.authorize('temporary-user'),
      403,
      'session_owner_mismatch',
    );

    expect(registry.prepareRelease('temporary-user', OWNER_A, { creationInflight: false })).toBe(true);
    expect(registry.release('temporary-user', OWNER_A)).toBe(true);
  });

  test('stores only a digest, never the raw owner token', () => {
    const registry = createSessionOwnershipRegistry();
    registry.claim('temporary-user', OWNER_A, {
      sessionExists: false,
      creationInflight: false,
    });

    expect(JSON.stringify(registry)).not.toContain(OWNER_A);
    expect(String(registry)).not.toContain(OWNER_A);
  });

  test('expires only abandoned claims when the server proves release is safe', () => {
    let now = 10;
    const registry = createSessionOwnershipRegistry({
      ttlMs: 100,
      now: () => now,
    });
    registry.claim('temporary-user', OWNER_A, {
      sessionExists: false,
      creationInflight: false,
    });

    now = 109;
    expect(registry.authorize('temporary-user', OWNER_A)).toBe(true);
    now = 210;
    expect(registry.hasClaim('temporary-user')).toBe(true);
    expect(registry.purgeExpired(() => false)).toBe(0);
    expect(registry.hasClaim('temporary-user')).toBe(true);
    expect(registry.purgeExpired(userId => userId === 'temporary-user')).toBe(1);
    expect(registry.hasClaim('temporary-user')).toBe(false);
    expect(registry.authorize('temporary-user', undefined)).toBe(false);
  });
});
