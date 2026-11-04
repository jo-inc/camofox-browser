/**
 * Tab control flag for agent handoff.
 *
 * Each tab is either under the agent's control (the default) or under a
 * person's control. While a person holds a tab, agent action routes refuse to
 * act and return 409 `human_in_control`.
 *
 * Human control expires after an idle period so a forgotten takeover can never
 * leave a tab stuck. The clock is injectable so the expiry rules can be tested
 * without waiting.
 *
 * This module is pure state, with no browser calls. Handoff routes in server.js
 * set and clear human control, and the live viewer checks it before forwarding
 * input from a person.
 */

export const HUMAN_CONTROL_DEFAULT_IDLE_MS = 10 * 60 * 1000;
export const HUMAN_CONTROL_MIN_IDLE_MS = 10 * 1000;
export const HUMAN_CONTROL_MAX_IDLE_MS = 30 * 60 * 1000;
const REASON_MAX_LENGTH = 200;
const TAB_ID_MAX_LENGTH = 256;

const controls = new Map();

function assertTabId(tabId) {
  if (typeof tabId !== 'string' || tabId.length === 0 || tabId.length > TAB_ID_MAX_LENGTH) {
    throw new Error('tabId must be a non-empty string of at most 256 characters');
  }
}

function clampIdle(idleMs) {
  const value = Number(idleMs);
  if (!Number.isFinite(value)) return HUMAN_CONTROL_DEFAULT_IDLE_MS;
  return Math.min(Math.max(value, HUMAN_CONTROL_MIN_IDLE_MS), HUMAN_CONTROL_MAX_IDLE_MS);
}

/**
 * @returns {{mode: 'agent'} | {mode: 'human', since: number, until: number, reason: string}}
 */
export function getControl(tabId, now = Date.now()) {
  assertTabId(tabId);
  const entry = controls.get(tabId);
  if (!entry) return { mode: 'agent' };
  if (now >= entry.until) {
    controls.delete(tabId);
    return { mode: 'agent' };
  }
  return { mode: 'human', since: entry.since, until: entry.until, reason: entry.reason };
}

/**
 * Give the tab to a person. Replaces any earlier human hold.
 */
export function setHuman(tabId, { reason = 'handoff', idleMs, now = Date.now() } = {}) {
  assertTabId(tabId);
  const idle = clampIdle(idleMs);
  controls.set(tabId, {
    since: now,
    until: now + idle,
    reason: String(reason || 'handoff').slice(0, REASON_MAX_LENGTH),
  });
  return getControl(tabId, now);
}

/**
 * A person acted on the tab, so push the idle expiry forward. No effect when
 * the tab is under the agent's control.
 */
export function touchHuman(tabId, { idleMs, now = Date.now() } = {}) {
  assertTabId(tabId);
  const current = getControl(tabId, now);
  if (current.mode !== 'human') return current;
  const idle = clampIdle(idleMs);
  const entry = controls.get(tabId);
  entry.until = now + idle;
  return getControl(tabId, now);
}

/**
 * Return control to the agent.
 */
export function setAgent(tabId) {
  assertTabId(tabId);
  controls.delete(tabId);
  return { mode: 'agent' };
}

/**
 * Gate for agent action routes. Returns null when the agent may act, or the
 * 409 response body when a person holds the tab.
 */
export function agentActionBlock(tabId, now = Date.now()) {
  const control = getControl(tabId, now);
  if (control.mode !== 'human') return null;
  return {
    error: 'human_in_control',
    message:
      'A person is controlling this browser tab. Stop acting on it and tell the user. Act again only after control returns to the agent.',
    until: new Date(control.until).toISOString(),
    reason: control.reason,
  };
}

/**
 * Drop all state. Used when a tab closes, and by tests.
 */
export function resetTabControl() {
  controls.clear();
}
