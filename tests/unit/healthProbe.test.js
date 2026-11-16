'use strict';

import { describe, test, expect, jest } from '@jest/globals';
import { createHealthProbe } from '../../lib/health-probe.js';

function makeMocks() {
  const state = { contextsCreated: 0, pagesCreated: 0, closedPages: 0, closedContexts: 0 };
  const makePage = () => {
    let closed = false;
    state.pagesCreated++;
    return {
      goto: jest.fn(async () => {}),
      isClosed: () => closed,
      close: jest.fn(async () => { closed = true; state.closedPages++; }),
      _forceClose: () => { closed = true; },
    };
  };
  const newContext = jest.fn(async () => {
    state.contextsCreated++;
    const pages = [];
    return {
      newPage: async () => { const p = makePage(); pages.push(p); return p; },
      close: jest.fn(async () => { state.closedContexts++; }),
      _pages: pages,
    };
  });
  return { state, newContext };
}

describe('health probe context reuse', () => {
  test('creates exactly one context on the first probe', async () => {
    const { state, newContext } = makeMocks();
    const probe = createHealthProbe({ newContext });
    await probe.probe();
    expect(state.contextsCreated).toBe(1);
    expect(state.pagesCreated).toBe(1);
  });

  test('reuses the same context across repeated probes', async () => {
    // The regression this guards: the original probe called browser.newContext()
    // every run. On a real display each context is a top-level window, so the
    // liveness check made a window appear and vanish every few minutes.
    const { state, newContext } = makeMocks();
    const probe = createHealthProbe({ newContext });
    await probe.probe();
    await probe.probe();
    await probe.probe();
    expect(state.contextsCreated).toBe(1);
    expect(state.pagesCreated).toBe(1);
    expect(state.closedContexts).toBe(0);
  });

  test('still navigates on every probe, so a frozen browser is detected', async () => {
    const { newContext } = makeMocks();
    const probe = createHealthProbe({ newContext });
    await probe.probe();
    const page = (await newContext.mock.results[0].value)._pages[0];
    await probe.probe();
    expect(page.goto).toHaveBeenCalledTimes(2);
    expect(page.goto).toHaveBeenCalledWith('about:blank', { timeout: 5000 });
  });

  test('rebuilds the context when the page has gone away', async () => {
    const { state, newContext } = makeMocks();
    const probe = createHealthProbe({ newContext });
    await probe.probe();
    const ctx = await newContext.mock.results[0].value;
    ctx._pages[0]._forceClose();          // e.g. the browser was restarted
    await probe.probe();
    expect(state.contextsCreated).toBe(2);
  });

  test('propagates the failure when a fresh context also cannot navigate', async () => {
    // The caller restarts the browser on a thrown error; swallowing it here
    // would turn a dead browser into a silently healthy one.
    const newContext = jest.fn(async () => ({
      newPage: async () => ({
        goto: async () => { throw new Error('Target closed'); },
        isClosed: () => false,
        close: async () => {},
      }),
      close: async () => {},
    }));
    const probe = createHealthProbe({ newContext });
    await expect(probe.probe()).rejects.toThrow('Target closed');
  });

  test('dispose closes the page and the context', async () => {
    const { state, newContext } = makeMocks();
    const probe = createHealthProbe({ newContext });
    await probe.probe();
    await probe.dispose();
    expect(state.closedPages).toBe(1);
    expect(state.closedContexts).toBe(1);
  });
});
