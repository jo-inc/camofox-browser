/**
 * Unit tests for session cleanup after tab reaper empties all tabs.
 *
 * Tests the logic that when the tab reaper closes all idle tabs in a session,
 * the empty session (browser context) should be cleaned up immediately rather
 * than lingering until the session timeout.
 */

describe('session cleanup after tab reaper', () => {
  // Simulate the reaper loop logic from server.js
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
      // The fix: clean up empty sessions
      if (session.tabGroups.size === 0) {
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
    // Active tab should still be present
    const session = sessions.get('user-1');
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
