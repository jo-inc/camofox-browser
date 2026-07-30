import { isPressureTabStillEligible } from '../../lib/pressure-cleanup.js';

describe('pressure cleanup eligibility revalidation', () => {
  const selected = {
    toolCalls: 4,
    pressureObservedToolCalls: 4,
    pressureObservedAt: 1_000,
  };

  test('keeps an unchanged idle candidate eligible', () => {
    expect(isPressureTabStillEligible(selected, {
      selectedToolCalls: 4,
      minIdleMs: 500,
      now: 1_500,
    })).toBe(true);
  });

  test('rejects a stale candidate used while destructive cleanup waited', () => {
    const usedAfterSelection = {
      ...selected,
      toolCalls: 5,
      pressureObservedToolCalls: 5,
      pressureObservedAt: 1_400,
    };
    expect(isPressureTabStillEligible(usedAfterSelection, {
      selectedToolCalls: 4,
      minIdleMs: 500,
      now: 1_500,
    })).toBe(false);
  });

  test('rejects refreshed activity and candidates no longer idle enough', () => {
    expect(isPressureTabStillEligible({
      ...selected,
      pressureObservedToolCalls: 3,
    }, {
      selectedToolCalls: 4,
      minIdleMs: 500,
      now: 1_500,
    })).toBe(false);
    expect(isPressureTabStillEligible({
      ...selected,
      pressureObservedAt: 1_250,
    }, {
      selectedToolCalls: 4,
      minIdleMs: 500,
      now: 1_500,
    })).toBe(false);
  });
});
