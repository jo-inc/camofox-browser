import {
  createRateLimiter,
  toViewportPoint,
  validateLiveInput,
  MAX_TYPED_TEXT_LENGTH,
  MAX_SCROLL_DELTA,
} from '../../lib/live-input.js';

describe('validateLiveInput (unit)', () => {
  test('rejects non-object bodies', () => {
    expect(validateLiveInput(null).ok).toBe(false);
    expect(validateLiveInput('click').ok).toBe(false);
    expect(validateLiveInput([]).ok).toBe(false);
  });

  test('rejects unknown actions', () => {
    expect(validateLiveInput({ action: 'evaluate', expression: '1' }).ok).toBe(false);
    expect(validateLiveInput({}).ok).toBe(false);
  });

  test('accepts click and dblclick with normalized coordinates', () => {
    expect(validateLiveInput({ action: 'click', x: 0.5, y: 0.25 })).toEqual({ ok: true, action: 'click', x: 0.5, y: 0.25 });
    expect(validateLiveInput({ action: 'dblclick', x: 0, y: 1 }).ok).toBe(true);
  });

  test('rejects coordinates outside 0..1 or non-numeric', () => {
    expect(validateLiveInput({ action: 'click', x: 1.2, y: 0.5 }).ok).toBe(false);
    expect(validateLiveInput({ action: 'click', x: -0.1, y: 0.5 }).ok).toBe(false);
    expect(validateLiveInput({ action: 'click', x: '0.5', y: 0.5 }).ok).toBe(false);
    expect(validateLiveInput({ action: 'click', x: NaN, y: 0.5 }).ok).toBe(false);
    expect(validateLiveInput({ action: 'click', x: 0.5 }).ok).toBe(false);
  });

  test('accepts typed text and rejects empty, too long or control-character text', () => {
    expect(validateLiveInput({ action: 'type', text: 'user@example.com' })).toEqual({
      ok: true,
      action: 'type',
      text: 'user@example.com',
    });
    expect(validateLiveInput({ action: 'type', text: '' }).ok).toBe(false);
    expect(validateLiveInput({ action: 'type', text: 'a'.repeat(MAX_TYPED_TEXT_LENGTH + 1) }).ok).toBe(false);
    expect(validateLiveInput({ action: 'type', text: 'line\nbreak' }).ok).toBe(false);
    expect(validateLiveInput({ action: 'type', text: 'tab\there' }).ok).toBe(false);
    expect(validateLiveInput({ action: 'type', text: 42 }).ok).toBe(false);
  });

  test('accepts only allow-listed keys', () => {
    expect(validateLiveInput({ action: 'key', key: 'Enter' })).toEqual({ ok: true, action: 'key', key: 'Enter' });
    expect(validateLiveInput({ action: 'key', key: 'ArrowDown' }).ok).toBe(true);
    expect(validateLiveInput({ action: 'key', key: 'Control' }).ok).toBe(false);
    expect(validateLiveInput({ action: 'key', key: 'F12' }).ok).toBe(false);
    expect(validateLiveInput({ action: 'key', key: 'a' }).ok).toBe(false);
  });

  test('bounds scroll deltas', () => {
    expect(validateLiveInput({ action: 'scroll', deltaY: 300 }).ok).toBe(true);
    expect(validateLiveInput({ action: 'scroll', deltaY: -300 }).ok).toBe(true);
    expect(validateLiveInput({ action: 'scroll', deltaY: MAX_SCROLL_DELTA + 1 }).ok).toBe(false);
    expect(validateLiveInput({ action: 'scroll', deltaY: 'down' }).ok).toBe(false);
    expect(validateLiveInput({ action: 'scroll' }).ok).toBe(false);
  });
});

describe('toViewportPoint (unit)', () => {
  const viewport = { width: 1280, height: 800 };

  test('maps normalized points onto the viewport', () => {
    expect(toViewportPoint(0, 0, viewport)).toEqual({ x: 0, y: 0 });
    expect(toViewportPoint(0.5, 0.5, viewport)).toEqual({ x: 640, y: 400 });
  });

  test('clamps to the last pixel of the viewport', () => {
    expect(toViewportPoint(1, 1, viewport)).toEqual({ x: 1279, y: 799 });
    expect(toViewportPoint(-1, 2, viewport)).toEqual({ x: 0, y: 799 });
  });

  test('falls back to the default viewport when none is given', () => {
    expect(toViewportPoint(1, 1, null)).toEqual({ x: 1279, y: 799 });
  });
});

describe('createRateLimiter (unit)', () => {
  test('allows up to the limit within the window, then refuses', () => {
    let t = 0;
    const limiter = createRateLimiter({ limit: 3, windowMs: 1000, now: () => t });
    expect([limiter.take(), limiter.take(), limiter.take(), limiter.take()]).toEqual([true, true, true, false]);
  });

  test('recovers once the window has passed', () => {
    let t = 0;
    const limiter = createRateLimiter({ limit: 2, windowMs: 1000, now: () => t });
    limiter.take();
    limiter.take();
    expect(limiter.take()).toBe(false);
    t = 1000;
    expect(limiter.take()).toBe(true);
  });
});
