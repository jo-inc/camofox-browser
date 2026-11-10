/**
 * Page scroll: a wheel that does not settle (seen in a headed browser) falls back to scrollBy
 * instead of holding the tab until the route's action timeout.
 */
import { describe, test, expect, jest } from '@jest/globals';
import { readFileSync } from 'fs';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';
import { scrollDeltas, scrollPage } from '../../lib/scroll.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const serverSource = readFileSync(resolve(__dirname, '../../server.js'), 'utf8');

function fakePage({ wheel, evaluate = () => Promise.resolve() }) {
  return { mouse: { wheel: jest.fn(wheel) }, evaluate: jest.fn(evaluate) };
}

describe('scrollDeltas', () => {
  test.each([
    ['down', 500, [0, 500]],
    ['up', 500, [0, -500]],
    ['right', 120, [120, 0]],
    ['left', 120, [-120, 0]],
  ])('%s %i', (direction, amount, expected) => {
    expect(scrollDeltas(direction, amount)).toEqual(expected);
  });
});

describe('scrollPage', () => {
  test('a wheel that settles is the whole scroll', async () => {
    const page = fakePage({ wheel: () => Promise.resolve() });
    await expect(scrollPage(page, 'down', 300)).resolves.toBe('wheel');
    expect(page.mouse.wheel).toHaveBeenCalledWith(0, 300);
    expect(page.evaluate).not.toHaveBeenCalled();
  });

  test('a wheel that does not settle falls back to scrollBy and logs it', async () => {
    const page = fakePage({ wheel: () => new Promise(() => {}) });
    const log = jest.fn();
    await expect(scrollPage(page, 'up', 200, { wheelTimeoutMs: 20, log })).resolves.toBe('scrollBy');
    expect(page.evaluate).toHaveBeenCalledTimes(1);
    expect(page.evaluate.mock.calls[0][1]).toEqual([0, -200]);
    expect(log).toHaveBeenCalledWith('warn', expect.stringContaining('did not settle'), expect.objectContaining({ direction: 'up' }));
  });

  test('a wheel that rejects after the fallback does not raise an unhandled rejection', async () => {
    let rejectWheel;
    const page = fakePage({ wheel: () => new Promise((_, reject) => { rejectWheel = reject; }) });
    await scrollPage(page, 'down', 100, { wheelTimeoutMs: 10 });
    rejectWheel(new Error('page closed'));
    await new Promise((r) => setTimeout(r, 10));
  });

  test('a wheel that fails quickly is an error, not a fallback', async () => {
    const page = fakePage({ wheel: () => Promise.reject(new Error('Target closed')) });
    await expect(scrollPage(page, 'down', 100)).rejects.toThrow('Target closed');
    expect(page.evaluate).not.toHaveBeenCalled();
  });
});

describe('scroll routes', () => {
  test('/scroll and the /act scroll action both go through scrollPage', () => {
    expect(serverSource).not.toMatch(/page\.mouse\.wheel\(isVertical/);
    const route = serverSource.slice(serverSource.indexOf("app.post('/tabs/:tabId/scroll'"));
    expect(route.slice(0, route.indexOf('\napp.'))).toContain('scrollPage(');
    const act = serverSource.slice(serverSource.indexOf("case 'scrollIntoView'"));
    expect(act.slice(0, 1200)).toContain('scrollPage(');
  });
});
