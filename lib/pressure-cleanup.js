export function isPressureTabStillEligible(tabState, {
  selectedToolCalls,
  minIdleMs,
  now = Date.now(),
}) {
  if (!tabState || tabState.toolCalls !== selectedToolCalls) return false;
  if (!Number.isFinite(tabState.pressureObservedAt)) return false;
  if (tabState.pressureObservedToolCalls !== tabState.toolCalls) return false;
  return now - tabState.pressureObservedAt >= minIdleMs;
}
