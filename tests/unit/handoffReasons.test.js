import { HANDOFF_REASON_BY_STATE, PAGE_STATE_KINDS } from '../../lib/page-state.js';

describe('auto-handoff reasons (unit)', () => {
  test('captcha, sign-in wall and verification-code pages each have a reason shown to the person', () => {
    expect(HANDOFF_REASON_BY_STATE.captcha).toMatch(/human check/);
    expect(HANDOFF_REASON_BY_STATE.login_wall).toMatch(/sign in/);
    expect(HANDOFF_REASON_BY_STATE.two_factor).toMatch(/verification code/);
  });

  test('pages the agent can handle never start a handoff', () => {
    for (const kind of ['block', 'consent', 'no_results', 'ok']) {
      expect(PAGE_STATE_KINDS).toContain(kind);
      expect(HANDOFF_REASON_BY_STATE[kind]).toBeUndefined();
    }
  });

  test('every reason is short enough for the handoff reason field (200 characters)', () => {
    for (const reason of Object.values(HANDOFF_REASON_BY_STATE)) {
      expect(reason.length).toBeLessThanOrEqual(200);
    }
  });

  test('the mapping is frozen so it cannot be changed at runtime', () => {
    expect(Object.isFrozen(HANDOFF_REASON_BY_STATE)).toBe(true);
  });
});
