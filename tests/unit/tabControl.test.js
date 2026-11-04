import { describe, test, expect, beforeEach } from '@jest/globals';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import {
  getControl,
  setHuman,
  touchHuman,
  setAgent,
  agentActionBlock,
  resetTabControl,
  HUMAN_CONTROL_DEFAULT_IDLE_MS,
  HUMAN_CONTROL_MIN_IDLE_MS,
  HUMAN_CONTROL_MAX_IDLE_MS,
} from '../../lib/tab-control.js';

const T0 = 1_000_000;

describe('tab control flag (unit)', () => {
  beforeEach(() => resetTabControl());

  test('a tab is under the agent by default, so the gate lets actions through', () => {
    expect(getControl('tab-a', T0)).toEqual({ mode: 'agent' });
    expect(agentActionBlock('tab-a', T0)).toBeNull();
  });

  test('setHuman gives the tab to a person and the gate refuses agent actions', () => {
    const control = setHuman('tab-a', { reason: 'captcha', now: T0 });
    expect(control.mode).toBe('human');
    expect(control.reason).toBe('captcha');
    const block = agentActionBlock('tab-a', T0 + 1);
    expect(block.error).toBe('human_in_control');
    expect(block.reason).toBe('captcha');
    expect(block.message).toMatch(/tell the user/);
  });

  test('control is per tab', () => {
    setHuman('tab-a', { now: T0 });
    expect(agentActionBlock('tab-b', T0)).toBeNull();
  });

  test('human control expires after the default idle period', () => {
    setHuman('tab-a', { now: T0 });
    expect(getControl('tab-a', T0 + HUMAN_CONTROL_DEFAULT_IDLE_MS - 1).mode).toBe('human');
    expect(getControl('tab-a', T0 + HUMAN_CONTROL_DEFAULT_IDLE_MS).mode).toBe('agent');
    expect(agentActionBlock('tab-a', T0 + HUMAN_CONTROL_DEFAULT_IDLE_MS)).toBeNull();
  });

  test('an expired hold is removed, so a later read stays agent', () => {
    setHuman('tab-a', { now: T0 });
    getControl('tab-a', T0 + HUMAN_CONTROL_DEFAULT_IDLE_MS + 1);
    expect(getControl('tab-a', T0).mode).toBe('agent');
  });

  test('touchHuman extends the hold, and does nothing for agent-controlled tabs', () => {
    setHuman('tab-a', { now: T0, idleMs: HUMAN_CONTROL_MIN_IDLE_MS });
    const touched = touchHuman('tab-a', { now: T0 + 5000, idleMs: HUMAN_CONTROL_MIN_IDLE_MS });
    expect(touched.until).toBe(T0 + 5000 + HUMAN_CONTROL_MIN_IDLE_MS);
    expect(touchHuman('tab-x', { now: T0 })).toEqual({ mode: 'agent' });
  });

  test('setAgent returns control immediately', () => {
    setHuman('tab-a', { now: T0 });
    expect(setAgent('tab-a')).toEqual({ mode: 'agent' });
    expect(agentActionBlock('tab-a', T0)).toBeNull();
  });

  test('idle period is clamped to the allowed range', () => {
    const tooShort = setHuman('tab-a', { now: T0, idleMs: 1 });
    expect(tooShort.until - T0).toBe(HUMAN_CONTROL_MIN_IDLE_MS);
    const tooLong = setHuman('tab-b', { now: T0, idleMs: 10 * HUMAN_CONTROL_MAX_IDLE_MS });
    expect(tooLong.until - T0).toBe(HUMAN_CONTROL_MAX_IDLE_MS);
    const notANumber = setHuman('tab-c', { now: T0, idleMs: 'soon' });
    expect(notANumber.until - T0).toBe(HUMAN_CONTROL_DEFAULT_IDLE_MS);
  });

  test('a long reason is truncated and an empty reason falls back to handoff', () => {
    const long = setHuman('tab-a', { now: T0, reason: 'x'.repeat(500) });
    expect(long.reason.length).toBe(200);
    expect(setHuman('tab-b', { now: T0, reason: '' }).reason).toBe('handoff');
  });

  test('rejects invalid tab identifiers', () => {
    expect(() => getControl('')).toThrow();
    expect(() => setHuman(undefined)).toThrow();
    expect(() => setAgent('x'.repeat(257))).toThrow();
  });

  test('the 409 body has a stable shape', () => {
    setHuman('tab-a', { now: T0 });
    const block = agentActionBlock('tab-a', T0);
    expect(Object.keys(block).sort()).toEqual(['error', 'message', 'reason', 'until']);
    expect(new Date(block.until).getTime()).toBe(T0 + HUMAN_CONTROL_DEFAULT_IDLE_MS);
  });
});

describe('action routes are gated (static guard)', () => {
  const serverSource = fs.readFileSync(
    path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'server.js'),
    'utf8',
  );

  const ACTION_ROUTES = [
    'navigate', 'click', 'upload', 'type', 'select', 'press',
    'scroll', 'back', 'forward', 'refresh', 'evaluate', 'overlays/dismiss',
  ];

  test.each(ACTION_ROUTES)('POST /tabs/:tabId/%s checks agentActionBlock first', (route) => {
    const start = serverSource.indexOf(`app.post('/tabs/:tabId/${route}'`);
    expect(start).toBeGreaterThan(-1);
    const head = serverSource.slice(start, start + 400);
    expect(head).toMatch(/agentActionBlock\(req\.params\.tabId\)/);
  });
});
