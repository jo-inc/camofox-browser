/**
 * Tests for tab leak fixes: safePageClose, getTotalTabCount, and orphan page reaper.
 *
 * Validates:
 * 1. safePageClose force-closes pages on timeout and cleans up listeners
 * 2. getTotalTabCount uses real Playwright page count for backpressure
 * 3. Orphan page reaper identifies and closes untracked pages
 */
import { describe, test, expect } from '@jest/globals';
import { jest } from '@jest/globals';

// ============================================================================
// safePageClose (extracted logic)
// ============================================================================

const PAGE_CLOSE_TIMEOUT_MS = 5000;

/**
 * Mirrors the safePageClose logic from server.js.
 * Returns: { action: 'skipped'|'closed'|'force_closed', removeAllListenersCalled: boolean }
 */
async function safePageClose(page) {
  if (!page || page.isClosed()) return { action: 'skipped', removeAllListenersCalled: false };
  try {
    await Promise.race([
      page.close({ runBeforeUnload: false }),
      new Promise((_, reject) => setTimeout(() => reject(new Error('page close timed out')), PAGE_CLOSE_TIMEOUT_MS)),
    ]);
    return { action: 'closed', removeAllListenersCalled: false };
  } catch (e) {
    try { await page.close({ runBeforeUnload: false }); } catch (_) {}
    page.removeAllListeners();
    return { action: 'force_closed', removeAllListenersCalled: true };
  }
}

// ============================================================================
// getTotalTabCount (extracted logic)
// ============================================================================

/**
 * Mirrors getTotalTabCount from server.js.
 * Uses context.pages().length when available, falls back to bookkeeping.
 */
function getTotalTabCount(sessions) {
  let total = 0;
  const countedContexts = new Set();
  for (const session of sessions.values()) {
    const contextIdentity = session.context?._persistentContext || session.context;
    if (countedContexts.has(contextIdentity)) continue;
    countedContexts.add(contextIdentity);
    try {
      total += contextIdentity.pages().length;
    } catch (_) {
      for (const candidate of sessions.values()) {
        const candidateIdentity = candidate.context?._persistentContext || candidate.context;
        if (candidateIdentity !== contextIdentity) continue;
        for (const group of candidate.tabGroups.values()) total += group.size;
      }
    }
  }
  return total;
}

// ============================================================================
// Orphan page reaper (extracted logic)
// ============================================================================

/**
 * Mirrors the orphan reaper interval logic from server.js.
 * Returns array of pages that were reaped.
 */
function findOrphanPages(sessions) {
  const orphans = [];
  const persistentRegistered = new Map();
  for (const session of sessions.values()) {
    if (session._closing || !session.context?._persistentContext) continue;
    const key = session.context._persistentContext;
    let registered = persistentRegistered.get(key);
    if (!registered) {
      registered = new Set();
      persistentRegistered.set(key, registered);
    }
    for (const group of session.tabGroups.values()) {
      for (const tabState of group.values()) registered.add(tabState.page);
    }
  }

  const scannedPersistent = new Set();
  for (const session of sessions.values()) {
    if (session._closing) continue;
    const contextKey = session.context?._persistentContext || session.context;
    const persistent = !!session.context?._persistentContext;
    if (persistent) {
      if (scannedPersistent.has(contextKey)) continue;
      scannedPersistent.add(contextKey);
    }
    let contextPages;
    try {
      contextPages = session.context.pages();
    } catch (_) {
      continue;
    }
    const registered = persistent ? persistentRegistered.get(contextKey) || new Set() : new Set();
    if (!persistent) {
      for (const group of session.tabGroups.values()) {
        for (const tabState of group.values()) registered.add(tabState.page);
      }
    }
    for (const page of contextPages) {
      if (!registered.has(page)) orphans.push(page);
    }
  }
  return orphans;
}

// ============================================================================
// Mock helpers
// ============================================================================

function createMockPage({ closeDelay = 0, closeFails = false, isClosed = false } = {}) {
  let closed = isClosed;
  let removeAllListenersCalled = false;
  return {
    isClosed: () => closed,
    close: jest.fn(async ({ runBeforeUnload } = {}) => {
      if (closeFails) throw new Error('Target closed');
      if (closeDelay > 0) {
        await new Promise(resolve => setTimeout(resolve, closeDelay));
      }
      closed = true;
    }),
    removeAllListeners: jest.fn(() => { removeAllListenersCalled = true; }),
    _removeAllListenersCalled: () => removeAllListenersCalled,
  };
}

// ============================================================================
// Tests: safePageClose
// ============================================================================

describe('safePageClose', () => {
  test('skips null page', async () => {
    const result = await safePageClose(null);
    expect(result.action).toBe('skipped');
  });

  test('skips undefined page', async () => {
    const result = await safePageClose(undefined);
    expect(result.action).toBe('skipped');
  });

  test('skips already-closed page', async () => {
    const page = createMockPage({ isClosed: true });
    const result = await safePageClose(page);
    expect(result.action).toBe('skipped');
    expect(page.close).not.toHaveBeenCalled();
  });

  test('closes page successfully on happy path', async () => {
    const page = createMockPage();
    const result = await safePageClose(page);
    expect(result.action).toBe('closed');
    expect(page.close).toHaveBeenCalledWith({ runBeforeUnload: false });
    expect(result.removeAllListenersCalled).toBe(false);
  });

  test('force-closes and removes listeners when close throws', async () => {
    let callCount = 0;
    const page = {
      isClosed: () => false,
      close: jest.fn(async () => {
        callCount++;
        if (callCount === 1) throw new Error('close failed');
        // Second call succeeds (force-close)
      }),
      removeAllListeners: jest.fn(),
    };
    const result = await safePageClose(page);
    expect(result.action).toBe('force_closed');
    expect(result.removeAllListenersCalled).toBe(true);
    expect(page.close).toHaveBeenCalledTimes(2);
    expect(page.removeAllListeners).toHaveBeenCalled();
  });

  test('force-closes when page.close hangs past timeout', async () => {
    // Use a very short timeout for test speed
    const SHORT_TIMEOUT = 50;
    async function safePageCloseShort(page) {
      if (!page || page.isClosed()) return { action: 'skipped', removeAllListenersCalled: false };
      try {
        await Promise.race([
          page.close({ runBeforeUnload: false }),
          new Promise((_, reject) => setTimeout(() => reject(new Error('page close timed out')), SHORT_TIMEOUT)),
        ]);
        return { action: 'closed', removeAllListenersCalled: false };
      } catch (e) {
        try { await page.close({ runBeforeUnload: false }); } catch (_) {}
        page.removeAllListeners();
        return { action: 'force_closed', removeAllListenersCalled: true };
      }
    }

    // Simulate a page whose close() never resolves (hung Firefox process)
    let callCount = 0;
    const page = {
      isClosed: () => false,
      close: jest.fn(() => {
        callCount++;
        if (callCount === 1) return new Promise(() => {}); // never resolves
        return Promise.resolve(); // force-close succeeds
      }),
      removeAllListeners: jest.fn(),
    };
    const result = await safePageCloseShort(page);
    expect(result.action).toBe('force_closed');
    expect(result.removeAllListenersCalled).toBe(true);
    expect(page.removeAllListeners).toHaveBeenCalled();
    expect(page.close).toHaveBeenCalledTimes(2);
  });

  test('handles force-close also failing gracefully', async () => {
    const page = {
      isClosed: () => false,
      close: jest.fn(async () => { throw new Error('always fails'); }),
      removeAllListeners: jest.fn(),
    };
    const result = await safePageClose(page);
    expect(result.action).toBe('force_closed');
    expect(page.removeAllListeners).toHaveBeenCalled();
  });

  test('passes runBeforeUnload: false to skip unload handlers', async () => {
    const page = createMockPage();
    await safePageClose(page);
    expect(page.close).toHaveBeenCalledWith({ runBeforeUnload: false });
  });
});

// ============================================================================
// Tests: getTotalTabCount
// ============================================================================

describe('getTotalTabCount', () => {
  test('returns 0 for empty sessions map', () => {
    expect(getTotalTabCount(new Map())).toBe(0);
  });

  test('uses context.pages().length when context is alive', () => {
    const sessions = new Map([
      ['user1', {
        context: { pages: () => [{}, {}, {}] }, // 3 real pages
        tabGroups: new Map([['list1', new Map([['tab1', {}]])]]), // only 1 tracked
      }],
    ]);
    // Should use real count (3), not bookkeeping (1)
    expect(getTotalTabCount(sessions)).toBe(3);
  });

  test('falls back to bookkeeping when context.pages() throws', () => {
    const sessions = new Map([
      ['user1', {
        context: { pages: () => { throw new Error('context dead'); } },
        tabGroups: new Map([
          ['list1', new Map([['tab1', {}], ['tab2', {}]])],
          ['list2', new Map([['tab3', {}]])],
        ]),
      }],
    ]);
    expect(getTotalTabCount(sessions)).toBe(3);
  });

  test('sums across multiple sessions', () => {
    const sessions = new Map([
      ['user1', { context: { pages: () => [{}, {}] }, tabGroups: new Map() }],
      ['user2', { context: { pages: () => [{}] }, tabGroups: new Map() }],
      ['user3', { context: { pages: () => [{}, {}, {}, {}] }, tabGroups: new Map() }],
    ]);
    expect(getTotalTabCount(sessions)).toBe(7);
  });

  test('counts one shared persistent context only once', () => {
    const nativeContext = { pages: () => [{}, {}, {}] };
    const lease1 = { _persistentContext: nativeContext, pages: nativeContext.pages };
    const lease2 = { _persistentContext: nativeContext, pages: nativeContext.pages };
    const sessions = new Map([
      ['user1', { context: lease1, tabGroups: new Map() }],
      ['user2', { context: lease2, tabGroups: new Map() }],
    ]);
    expect(getTotalTabCount(sessions)).toBe(3);
  });

  test('mixed: some contexts alive, some dead', () => {
    const sessions = new Map([
      ['user1', { context: { pages: () => [{}, {}] }, tabGroups: new Map() }],
      ['user2', {
        context: { pages: () => { throw new Error('dead'); } },
        tabGroups: new Map([['list1', new Map([['t1', {}], ['t2', {}], ['t3', {}]])]]),
      }],
    ]);
    // user1: 2 (real), user2: 3 (fallback)
    expect(getTotalTabCount(sessions)).toBe(5);
  });

  test('leaked pages are visible in real count but not bookkeeping', () => {
    const trackedPage = { id: 'tracked' };
    const leakedPage1 = { id: 'leaked1' };
    const leakedPage2 = { id: 'leaked2' };
    const sessions = new Map([
      ['user1', {
        context: { pages: () => [trackedPage, leakedPage1, leakedPage2] },
        tabGroups: new Map([['list1', new Map([['tab1', { page: trackedPage }]])]]),
      }],
    ]);
    // Real count = 3 (includes leaks), bookkeeping would say 1
    expect(getTotalTabCount(sessions)).toBe(3);
  });
});

// ============================================================================
// Tests: orphan page reaper
// ============================================================================

describe('findOrphanPages (orphan page reaper)', () => {
  test('returns empty when no sessions', () => {
    expect(findOrphanPages(new Map())).toEqual([]);
  });

  test('returns empty when all pages are tracked', () => {
    const page1 = { id: 'p1' };
    const page2 = { id: 'p2' };
    const sessions = new Map([
      ['user1', {
        _closing: false,
        context: { pages: () => [page1, page2] },
        tabGroups: new Map([
          ['list1', new Map([['tab1', { page: page1 }], ['tab2', { page: page2 }]])],
        ]),
      }],
    ]);
    expect(findOrphanPages(sessions)).toEqual([]);
  });

  test('identifies orphan pages not in tabGroups', () => {
    const tracked = { id: 'tracked' };
    const orphan1 = { id: 'orphan1' };
    const orphan2 = { id: 'orphan2' };
    const sessions = new Map([
      ['user1', {
        _closing: false,
        context: { pages: () => [tracked, orphan1, orphan2] },
        tabGroups: new Map([['list1', new Map([['tab1', { page: tracked }]])]]),
      }],
    ]);
    const orphans = findOrphanPages(sessions);
    expect(orphans).toHaveLength(2);
    expect(orphans).toContain(orphan1);
    expect(orphans).toContain(orphan2);
  });

  test('skips sessions that are closing', () => {
    const orphan = { id: 'orphan' };
    const sessions = new Map([
      ['user1', {
        _closing: true,
        context: { pages: () => [orphan] },
        tabGroups: new Map(),
      }],
    ]);
    expect(findOrphanPages(sessions)).toEqual([]);
  });

  test('skips sessions where context.pages() throws', () => {
    const sessions = new Map([
      ['user1', {
        _closing: false,
        context: { pages: () => { throw new Error('context destroyed'); } },
        tabGroups: new Map(),
      }],
    ]);
    expect(findOrphanPages(sessions)).toEqual([]);
  });

  test('finds orphans across multiple sessions', () => {
    const tracked1 = { id: 't1' };
    const tracked2 = { id: 't2' };
    const orphan1 = { id: 'o1' };
    const orphan2 = { id: 'o2' };
    const sessions = new Map([
      ['user1', {
        _closing: false,
        context: { pages: () => [tracked1, orphan1] },
        tabGroups: new Map([['list1', new Map([['tab1', { page: tracked1 }]])]]),
      }],
      ['user2', {
        _closing: false,
        context: { pages: () => [tracked2, orphan2] },
        tabGroups: new Map([['list1', new Map([['tab1', { page: tracked2 }]])]]),
      }],
    ]);
    const orphans = findOrphanPages(sessions);
    expect(orphans).toHaveLength(2);
    expect(orphans).toContain(orphan1);
    expect(orphans).toContain(orphan2);
  });

  test('does not reap sibling-session pages in one persistent context', () => {
    const tracked1 = { id: 't1' };
    const tracked2 = { id: 't2' };
    const keeper = { id: 'keeper' };
    const nativeContext = { pages: () => [tracked1, tracked2, keeper] };
    const lease = () => ({ _persistentContext: nativeContext, pages: nativeContext.pages });
    const sessions = new Map([
      ['user1', {
        _closing: false,
        context: lease(),
        tabGroups: new Map([['list1', new Map([['tab1', { page: tracked1 }]])]]),
      }],
      ['user2', {
        _closing: false,
        context: lease(),
        tabGroups: new Map([['list2', new Map([['tab2', { page: tracked2 }]])]]),
      }],
    ]);

    expect(findOrphanPages(sessions)).toEqual([keeper]);
  });

  test('handles session with empty tabGroups (all pages are orphans)', () => {
    const page1 = { id: 'p1' };
    const page2 = { id: 'p2' };
    const sessions = new Map([
      ['user1', {
        _closing: false,
        context: { pages: () => [page1, page2] },
        tabGroups: new Map(),
      }],
    ]);
    const orphans = findOrphanPages(sessions);
    expect(orphans).toHaveLength(2);
  });

  test('handles multiple tabGroups per session correctly', () => {
    const p1 = { id: 'p1' };
    const p2 = { id: 'p2' };
    const p3 = { id: 'p3' };
    const orphan = { id: 'orphan' };
    const sessions = new Map([
      ['user1', {
        _closing: false,
        context: { pages: () => [p1, p2, p3, orphan] },
        tabGroups: new Map([
          ['list1', new Map([['tab1', { page: p1 }]])],
          ['list2', new Map([['tab2', { page: p2 }], ['tab3', { page: p3 }]])],
        ]),
      }],
    ]);
    const orphans = findOrphanPages(sessions);
    expect(orphans).toEqual([orphan]);
  });
});
