/**
 * Unit tests for session cleanup race conditions.
 *
 * Covers:
 * 1. Tab reaper → empty session cleanup (with _closing flag)
 * 2. getSession() skips sessions marked _closing
 * 3. YT transcript cleanup uses context.pages() instead of tabGroups
 * 4. Session expiry sets _closing before teardown
 */

describe('session cleanup after tab reaper', () => {
  // Simulate the reaper loop logic from server.js (with _closing flag)
  function runTabReaper({ sessions, TAB_INACTIVITY_MS, destroyTab, onSessionEmpty }) {
    const now = Date.now();
    for (const [userId, session] of sessions) {
      for (const [listItemId, group] of session.tabGroups) {
        for (const [tabId, tabState] of group) {
          if (!tabState._lastReaperCheck) {
            tabState._lastReaperCheck = now;
            tabState._lastReaperToolCalls = tabState.toolCalls;
            continue;
          }
          if (tabState.toolCalls === tabState._lastReaperToolCalls) {
            const idleMs = now - tabState._lastReaperCheck;
            if (idleMs >= TAB_INACTIVITY_MS) {
              destroyTab(tabId);
              group.delete(tabId);
            }
          } else {
            tabState._lastReaperCheck = now;
            tabState._lastReaperToolCalls = tabState.toolCalls;
          }
        }
        if (group.size === 0) {
          session.tabGroups.delete(listItemId);
        }
      }
      if (session.tabGroups.size === 0) {
        session._closing = true;
        onSessionEmpty(userId);
        sessions.delete(userId);
      }
    }
  }

  function makeSession(tabs) {
    const tabGroups = new Map();
    const group = new Map();
    for (const [tabId, tabState] of Object.entries(tabs)) {
      group.set(tabId, { toolCalls: 0, ...tabState });
    }
    tabGroups.set('list-1', group);
    return { tabGroups, lastAccess: Date.now() };
  }

  test('empty session is cleaned up when all tabs are reaped', () => {
    const past = Date.now() - 600_000; // 10 min ago
    const sessions = new Map();
    sessions.set('user-1', makeSession({
      'tab-1': { _lastReaperCheck: past, _lastReaperToolCalls: 0, toolCalls: 0 },
      'tab-2': { _lastReaperCheck: past, _lastReaperToolCalls: 0, toolCalls: 0 },
    }));

    const destroyed = [];
    const emptied = [];

    runTabReaper({
      sessions,
      TAB_INACTIVITY_MS: 300_000,
      destroyTab: (id) => destroyed.push(id),
      onSessionEmpty: (userId) => emptied.push(userId),
    });

    expect(destroyed).toEqual(['tab-1', 'tab-2']);
    expect(emptied).toEqual(['user-1']);
    expect(sessions.size).toBe(0);
  });

  test('reaped session gets _closing flag set before deletion', () => {
    const past = Date.now() - 600_000;
    const sessions = new Map();
    const session = makeSession({
      'tab-1': { _lastReaperCheck: past, _lastReaperToolCalls: 0, toolCalls: 0 },
    });
    sessions.set('user-1', session);

    let closingFlagAtCallback = null;
    runTabReaper({
      sessions,
      TAB_INACTIVITY_MS: 300_000,
      destroyTab: () => {},
      onSessionEmpty: () => { closingFlagAtCallback = session._closing; },
    });

    // _closing should be set BEFORE the onSessionEmpty callback
    expect(closingFlagAtCallback).toBe(true);
  });

  test('session with active tabs is NOT cleaned up', () => {
    const past = Date.now() - 600_000;
    const sessions = new Map();
    sessions.set('user-1', makeSession({
      'tab-1': { _lastReaperCheck: past, _lastReaperToolCalls: 0, toolCalls: 0 },
      'tab-2': { _lastReaperCheck: past, _lastReaperToolCalls: 0, toolCalls: 5 }, // active
    }));

    const destroyed = [];
    const emptied = [];

    runTabReaper({
      sessions,
      TAB_INACTIVITY_MS: 300_000,
      destroyTab: (id) => destroyed.push(id),
      onSessionEmpty: (userId) => emptied.push(userId),
    });

    expect(destroyed).toEqual(['tab-1']);
    expect(emptied).toEqual([]);
    expect(sessions.size).toBe(1);
    const session = sessions.get('user-1');
    expect(session._closing).toBeUndefined();
    expect(session.tabGroups.get('list-1').has('tab-2')).toBe(true);
  });

  test('multiple sessions: only empty ones are cleaned up', () => {
    const past = Date.now() - 600_000;
    const sessions = new Map();
    sessions.set('user-1', makeSession({
      'tab-1': { _lastReaperCheck: past, _lastReaperToolCalls: 0, toolCalls: 0 },
    }));
    sessions.set('user-2', makeSession({
      'tab-2': { _lastReaperCheck: past, _lastReaperToolCalls: 0, toolCalls: 3 }, // active
    }));

    const emptied = [];

    runTabReaper({
      sessions,
      TAB_INACTIVITY_MS: 300_000,
      destroyTab: () => {},
      onSessionEmpty: (userId) => emptied.push(userId),
    });

    expect(emptied).toEqual(['user-1']);
    expect(sessions.size).toBe(1);
    expect(sessions.has('user-2')).toBe(true);
  });

  test('tabs not yet checked are skipped (first pass initializes reaper state)', () => {
    const sessions = new Map();
    sessions.set('user-1', makeSession({
      'tab-1': { toolCalls: 0 }, // no _lastReaperCheck
    }));

    const destroyed = [];
    const emptied = [];

    runTabReaper({
      sessions,
      TAB_INACTIVITY_MS: 300_000,
      destroyTab: (id) => destroyed.push(id),
      onSessionEmpty: (userId) => emptied.push(userId),
    });

    expect(destroyed).toEqual([]);
    expect(emptied).toEqual([]);
    expect(sessions.size).toBe(1);
  });
});

describe('getSession _closing flag handling', () => {
  // Simulate getSession logic from server.js
  function getSession(sessions, userId, createContext) {
    const key = String(userId);
    let session = sessions.get(key);

    if (session) {
      if (session._closing) {
        session = null;
      } else {
        try {
          session.context.pages();
        } catch {
          sessions.delete(key);
          session = null;
        }
      }
    }

    if (!session) {
      const context = createContext();
      session = { context, tabGroups: new Map(), lastAccess: Date.now() };
      sessions.set(key, session);
    }
    session.lastAccess = Date.now();
    return session;
  }

  test('returns existing session when context is alive', () => {
    const sessions = new Map();
    const existingContext = { pages: () => [] };
    sessions.set('user-1', { context: existingContext, tabGroups: new Map(), lastAccess: 0 });

    const result = getSession(sessions, 'user-1', () => { throw new Error('should not create'); });
    expect(result.context).toBe(existingContext);
  });

  test('skips session with _closing flag and creates new one', () => {
    const sessions = new Map();
    const oldContext = { pages: () => [] };
    sessions.set('user-1', { context: oldContext, tabGroups: new Map(), lastAccess: 0, _closing: true });

    const newContext = { pages: () => [] };
    const result = getSession(sessions, 'user-1', () => newContext);

    expect(result.context).toBe(newContext);
    expect(result.context).not.toBe(oldContext);
    expect(result._closing).toBeUndefined();
    // Old entry is replaced in the map
    expect(sessions.get('user-1').context).toBe(newContext);
  });

  test('recreates session when context.pages() throws', () => {
    const sessions = new Map();
    const deadContext = { pages: () => { throw new Error('context closed'); } };
    sessions.set('user-1', { context: deadContext, tabGroups: new Map(), lastAccess: 0 });

    const newContext = { pages: () => [] };
    const result = getSession(sessions, 'user-1', () => newContext);

    expect(result.context).toBe(newContext);
  });

  test('creates fresh session when none exists', () => {
    const sessions = new Map();
    const newContext = { pages: () => [] };
    const result = getSession(sessions, 'user-1', () => newContext);

    expect(result.context).toBe(newContext);
    expect(sessions.has('user-1')).toBe(true);
  });
});

describe('YT transcript session cleanup', () => {
  // Simulate the finally-block cleanup logic from browserTranscript
  function ytCleanup(sessions, ytKey, contextPagesResult, contextPagesThrows) {
    const ytSession = sessions.get(ytKey);
    if (ytSession && !ytSession._closing) {
      try {
        if (contextPagesThrows) throw new Error('context closed');
        const remainingPages = contextPagesResult;
        if (remainingPages.length === 0) {
          ytSession._closing = true;
          // context.close() would be called here
          sessions.delete(ytKey);
        }
      } catch {
        sessions.delete(ytKey);
      }
    }
  }

  test('does NOT close session when other pages are still open', () => {
    const sessions = new Map();
    const session = { context: {}, tabGroups: new Map(), lastAccess: Date.now() };
    sessions.set('__yt_transcript__', session);

    // Another transcript request still has a page open
    ytCleanup(sessions, '__yt_transcript__', [{ /* page */ }], false);

    expect(sessions.has('__yt_transcript__')).toBe(true);
    expect(session._closing).toBeUndefined();
  });

  test('closes session when no pages remain', () => {
    const sessions = new Map();
    const session = { context: {}, tabGroups: new Map(), lastAccess: Date.now() };
    sessions.set('__yt_transcript__', session);

    ytCleanup(sessions, '__yt_transcript__', [], false);

    expect(sessions.has('__yt_transcript__')).toBe(false);
    expect(session._closing).toBe(true);
  });

  test('cleans up map entry when context is already dead', () => {
    const sessions = new Map();
    const session = { context: {}, tabGroups: new Map(), lastAccess: Date.now() };
    sessions.set('__yt_transcript__', session);

    ytCleanup(sessions, '__yt_transcript__', [], true /* throws */);

    expect(sessions.has('__yt_transcript__')).toBe(false);
  });

  test('skips cleanup when session is already _closing', () => {
    const sessions = new Map();
    const session = { context: {}, tabGroups: new Map(), lastAccess: Date.now(), _closing: true };
    sessions.set('__yt_transcript__', session);

    ytCleanup(sessions, '__yt_transcript__', [], false);

    // Session is still in the map (another cleanup path owns it)
    expect(sessions.has('__yt_transcript__')).toBe(true);
  });

  test('concurrent requests: first closer sees pages, second sees empty', () => {
    const sessions = new Map();
    const session = { context: {}, tabGroups: new Map(), lastAccess: Date.now() };
    sessions.set('__yt_transcript__', session);

    // Request A finishes first — request B still has a page
    ytCleanup(sessions, '__yt_transcript__', [{ /* B's page */ }], false);
    expect(sessions.has('__yt_transcript__')).toBe(true);
    expect(session._closing).toBeUndefined();

    // Request B finishes — no pages left
    ytCleanup(sessions, '__yt_transcript__', [], false);
    expect(sessions.has('__yt_transcript__')).toBe(false);
    expect(session._closing).toBe(true);
  });
});

describe('session expiry _closing flag', () => {
  // Simulate session expiry logic from server.js
  function runSessionExpiry({ sessions, SESSION_TIMEOUT_MS, onExpired }) {
    const now = Date.now();
    for (const [userId, session] of sessions) {
      if (now - session.lastAccess > SESSION_TIMEOUT_MS) {
        session._closing = true;
        onExpired(userId);
        sessions.delete(userId);
      }
    }
  }

  test('expired session gets _closing flag before deletion', () => {
    const past = Date.now() - 600_000;
    const sessions = new Map();
    const session = { tabGroups: new Map(), lastAccess: past };
    sessions.set('user-1', session);

    let closingFlagAtCallback = null;
    runSessionExpiry({
      sessions,
      SESSION_TIMEOUT_MS: 300_000,
      onExpired: () => { closingFlagAtCallback = session._closing; },
    });

    expect(closingFlagAtCallback).toBe(true);
    expect(sessions.size).toBe(0);
  });

  test('active session is NOT expired or flagged', () => {
    const sessions = new Map();
    const session = { tabGroups: new Map(), lastAccess: Date.now() };
    sessions.set('user-1', session);

    runSessionExpiry({
      sessions,
      SESSION_TIMEOUT_MS: 300_000,
      onExpired: () => { throw new Error('should not expire'); },
    });

    expect(sessions.size).toBe(1);
    expect(session._closing).toBeUndefined();
  });
});
