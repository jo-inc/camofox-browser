/**
 * Focused tests for POST /tabs/:tabId/drag.
 *
 * The route is embedded in server.js, so the pure request contract and mouse
 * gesture helper are exercised directly while source assertions protect the
 * route's load-bearing wiring (locks, counters, activity, and freshness).
 */
import { describe, test, expect, jest } from '@jest/globals';
import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import {
  DRAG_DEFAULT_DURATION_MS,
  DRAG_DEFAULT_STEPS,
  DRAG_MAX_DURATION_MS,
  DRAG_MAX_STEPS,
  runTrustedDrag,
  trustedDragTimeoutMs,
  validateTrustedDragRequest,
} from '../../lib/trusted-drag.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const serverSrc = readFileSync(join(__dirname, '../../server.js'), 'utf8');

const validRequest = () => ({
  userId: 'agent1',
  start: { x: 10, y: 20 },
  end: { x: 110, y: 220 },
});

describe('trusted drag request validation', () => {
  test('requires a non-empty string userId', () => {
    expect(validateTrustedDragRequest({ ...validRequest(), userId: '' })).toMatchObject({ ok: false });
    expect(validateTrustedDragRequest({ ...validRequest(), userId: '   ' })).toMatchObject({ ok: false });
    expect(validateTrustedDragRequest({ ...validRequest(), userId: 123 })).toMatchObject({ ok: false });
  });

  test('requires finite numeric start and end coordinates', () => {
    for (const request of [
      { ...validRequest(), start: undefined },
      { ...validRequest(), end: undefined },
      { ...validRequest(), start: { x: '10', y: 20 } },
      { ...validRequest(), end: { x: 110, y: Infinity } },
      { ...validRequest(), start: { x: NaN, y: 20 } },
      { ...validRequest(), end: { x: 110, y: null } },
    ]) {
      expect(validateTrustedDragRequest(request)).toMatchObject({ ok: false });
    }
  });

  test('applies safe defaults', () => {
    expect(validateTrustedDragRequest(validRequest())).toEqual({
      ok: true,
      value: {
        ...validRequest(),
        steps: DRAG_DEFAULT_STEPS,
        durationMs: DRAG_DEFAULT_DURATION_MS,
        button: 'left',
      },
    });
  });

  test('accepts bounded integer steps and duration overrides', () => {
    const result = validateTrustedDragRequest({
      ...validRequest(),
      steps: 1,
      durationMs: DRAG_MAX_DURATION_MS,
      button: 'middle',
    });
    expect(result).toEqual({
      ok: true,
      value: { ...validRequest(), steps: 1, durationMs: DRAG_MAX_DURATION_MS, button: 'middle' },
    });
    expect(validateTrustedDragRequest({ ...validRequest(), steps: DRAG_MAX_STEPS, durationMs: 1, button: 'right' }).ok).toBe(true);
  });

  test('rejects invalid step, duration, and button values', () => {
    for (const request of [
      { ...validRequest(), steps: 0 },
      { ...validRequest(), steps: DRAG_MAX_STEPS + 1 },
      { ...validRequest(), steps: 1.5 },
      { ...validRequest(), durationMs: 0 },
      { ...validRequest(), durationMs: DRAG_MAX_DURATION_MS + 1 },
      { ...validRequest(), durationMs: 1.5 },
      { ...validRequest(), button: 'back' },
    ]) {
      expect(validateTrustedDragRequest(request)).toMatchObject({ ok: false });
    }
  });

  test('rejects unknown top-level and coordinate properties', () => {
    expect(validateTrustedDragRequest({ ...validRequest(), extra: true })).toMatchObject({ ok: false });
    expect(validateTrustedDragRequest({
      ...validRequest(),
      start: { ...validRequest().start, z: 1 },
    })).toMatchObject({ ok: false });
    expect(validateTrustedDragRequest({
      ...validRequest(),
      end: { ...validRequest().end, label: 'target' },
    })).toMatchObject({ ok: false });
  });

  test('keeps the drag timeout below the tab-lock queue timeout', () => {
    const maxDrag = { steps: DRAG_MAX_STEPS, durationMs: DRAG_MAX_DURATION_MS };
    expect(trustedDragTimeoutMs(maxDrag, 30000, 35000)).toBe(32000);
    expect(trustedDragTimeoutMs(maxDrag, 60000, 35000)).toBe(34000);
    expect(trustedDragTimeoutMs({ steps: 1, durationMs: 1 }, 30000, 35000)).toBe(30000);
  });
});

describe('trusted drag helper', () => {
  function makePage({ moveImpl } = {}) {
    const events = [];
    const page = {
      mouse: {
        move: jest.fn(async (x, y) => {
          events.push(['move', x, y]);
          return moveImpl?.(x, y);
        }),
        down: jest.fn(async (button) => events.push(['down', button])),
        up: jest.fn(async (button) => events.push(['up', button])),
      },
    };
    return { page, events };
  }

  test('moves to start, presses the requested button, interpolates to exact end, and uses deterministic total delay', async () => {
    const { page, events } = makePage();
    const sleep = jest.fn(async () => {});

    const result = await runTrustedDrag(page, {
      start: { x: 10, y: 20 },
      end: { x: 110, y: 220 },
      steps: 3,
      durationMs: 100,
      button: 'right',
    }, sleep);

    expect(events[0]).toEqual(['move', 10, 20]);
    expect(events[1]).toEqual(['down', { button: 'right' }]);
    expect(events.slice(2, 5)).toHaveLength(3);
    expect(events[2][0]).toBe('move');
    expect(events[2][1]).toBeCloseTo(43.33333333333333);
    expect(events[2][2]).toBeCloseTo(86.66666666666667);
    expect(events[3][1]).toBeCloseTo(76.66666666666666);
    expect(events[3][2]).toBeCloseTo(153.33333333333331);
    expect(events[4]).toEqual(['move', 110, 220]);
    expect(events[5]).toEqual(['up', { button: 'right' }]);
    expect(sleep.mock.calls.map(([ms]) => ms)).toEqual([33, 34, 33]);
    expect(sleep.mock.calls.reduce((total, [ms]) => total + ms, 0)).toBe(100);
    expect(result).toMatchObject({ ok: true, start: { x: 10, y: 20 }, end: { x: 110, y: 220 }, steps: 3, durationMs: 100, button: 'right' });
  });

  test('releases the mouse in finally when an interpolated move fails', async () => {
    const { page, events } = makePage({
      moveImpl: (_x, y) => {
        if (y > 20) throw new Error('move failed');
      },
    });

    await expect(runTrustedDrag(page, {
      start: { x: 10, y: 20 },
      end: { x: 110, y: 220 },
      steps: 2,
      durationMs: 20,
      button: 'middle',
    }, async () => {})).rejects.toThrow('move failed');
    expect(events.at(-1)).toEqual(['up', { button: 'middle' }]);
  });
});

describe('/drag source contract', () => {
  test('registers the atomic drag route and imports the focused helper', () => {
    expect(serverSrc).toMatch(/import \{[^}]*runTrustedDrag[^}]*\} from ['"]\.\/lib\/trusted-drag\.js['"]/s);
    expect(serverSrc).toMatch(/app\.post\(\s*['"]\/tabs\/:tabId\/drag['"]/);
  });

  test('uses user activity, counters, both locks, and freshness invalidation', () => {
    const start = serverSrc.indexOf("app.post('/tabs/:tabId/drag'");
    const end = serverSrc.indexOf('\n// ', start + 1);
    const block = serverSrc.slice(start, end === -1 ? undefined : end);
    expect(block).toMatch(/session\.lastAccess\s*=\s*Date\.now\(\)/);
    expect(block).toMatch(/tabState\.toolCalls\+\+/);
    expect(block).toMatch(/withUserLimit\(/);
    expect(block).toMatch(/withTabLock\(/);
    expect(block).toMatch(/tabState\.lastSnapshot\s*=\s*null/);
    expect(block).toMatch(/tabState\.refs\s*=\s*new Map\(\)/);
    expect(block).toMatch(/req\.body\.userId\s*=\s*userId/);
    expect(block).toMatch(/trustedDragTimeoutMs\([\s\S]*TAB_LOCK_TIMEOUT_MS/);
    expect(block).toMatch(/withTabLock\(tabId,[\s\S]*dragTimeoutMs\)/);
    expect(block).toMatch(/finally/);
  });

  test('performs a low-level mouse gesture rather than DOM dispatch', () => {
    const start = serverSrc.indexOf("app.post('/tabs/:tabId/drag'");
    const end = serverSrc.indexOf('\n// ', start + 1);
    const block = serverSrc.slice(start, end === -1 ? undefined : end);
    expect(block).toMatch(/runTrustedDrag\(tabState\.page/);
    expect(block).toMatch(/res\.json\(result\)/);
  });
});
