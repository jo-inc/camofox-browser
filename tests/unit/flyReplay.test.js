/**
 * Tests for horizontal scaling: tab ID encoding and fly-replay routing.
 */

import { createFlyHelpers } from '../../lib/fly.js';

describe('Tab ID machine encoding', () => {
  const MACHINE_A = '178139e6fe42d8';
  const MACHINE_B = 'abc123def45678';

  const flyA = createFlyHelpers({ flyMachineId: MACHINE_A });
  const flyNone = createFlyHelpers({ flyMachineId: '' });

  test('parseTabOwner extracts machine ID from prefixed tab ID', () => {
    const tabId = `${MACHINE_A}_a1b2c3d4-e5f6-7890-abcd-ef1234567890`;
    expect(flyA.parseTabOwner(tabId)).toBe(MACHINE_A);
  });

  test('parseTabOwner returns null for legacy UUID tab IDs', () => {
    const tabId = 'a1b2c3d4-e5f6-7890-abcd-ef1234567890';
    expect(flyA.parseTabOwner(tabId)).toBe(null);
  });

  test('parseTabOwner returns null when not on Fly (no machineId)', () => {
    const tabId = `${MACHINE_A}_a1b2c3d4-e5f6-7890-abcd-ef1234567890`;
    expect(flyNone.parseTabOwner(tabId)).toBe(null);
  });

  test('parseTabOwner returns null for empty tabId', () => {
    expect(flyA.parseTabOwner('')).toBe(null);
    expect(flyA.parseTabOwner(null)).toBe(null);
    expect(flyA.parseTabOwner(undefined)).toBe(null);
  });

  test('isLocalTab returns true for local machine tab', () => {
    const tabId = `${MACHINE_A}_a1b2c3d4-e5f6-7890-abcd-ef1234567890`;
    expect(flyA.isLocalTab(tabId)).toBe(true);
  });

  test('isLocalTab returns false for remote machine tab', () => {
    const tabId = `${MACHINE_B}_a1b2c3d4-e5f6-7890-abcd-ef1234567890`;
    expect(flyA.isLocalTab(tabId)).toBe(false);
  });

  test('isLocalTab returns true for legacy UUID (no prefix)', () => {
    const tabId = 'a1b2c3d4-e5f6-7890-abcd-ef1234567890';
    expect(flyA.isLocalTab(tabId)).toBe(true);
  });

  test('isLocalTab returns true when not on Fly', () => {
    const tabId = `${MACHINE_A}_a1b2c3d4-e5f6-7890-abcd-ef1234567890`;
    expect(flyNone.isLocalTab(tabId)).toBe(true);
  });

  test('parseTabOwner handles edge case: UUID whose first segment has no dash', () => {
    const tabId = 'abcdef12_some-uuid-here';
    expect(flyA.parseTabOwner(tabId)).toBe('abcdef12');
    const flyDiff = createFlyHelpers({ flyMachineId: 'different1' });
    expect(flyDiff.parseTabOwner(tabId)).toBe('abcdef12');
  });

  test('makeTabId includes machine prefix on Fly', () => {
    const tabId = flyA.makeTabId();
    expect(tabId.startsWith(`${MACHINE_A}_`)).toBe(true);
  });

  test('makeTabId returns plain UUID when not on Fly', () => {
    const tabId = flyNone.makeTabId();
    expect(tabId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-/);
    expect(tabId.includes('_')).toBe(false);
  });
});
