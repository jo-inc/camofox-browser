/**
 * Unit tests for the orphan page reaper (BugHunter#174).
 *
 * The reaper walks each session's context.pages() and force-closes any Page
 * NOT present in that session's tabGroups (orphans from prior safePageClose
 * timeouts). Registered pages are untouched.
 */
import { describe, test, expect, jest } from '@jest/globals';
import { readFileSync } from 'fs';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const serverSource = readFileSync(resolve(__dirname, '../../server.js'), 'utf8');

// Extract reaper logic by simulating its internals.
function buildOrphanReaper({ log = () => {} } = {}) {
  return function runOrphanReaper(sessions) {
    let reaped = 0;
    for (const session of sessions.values()) {
      if (session._closing) continue;
      let contextPages;
      try {
        contextPages = session.context.pages();
      } catch (_) {
        continue;
      }
      const registered = new Set();
      for (const group of session.tabGroups.values()) {
        for (const tabState of group.values()) registered.add(tabState.page);
      }
      for (const page of contextPages) {
        if (!registered.has(page)) {
          reaped++;
          page.removeAllListeners();
          page.close({ runBeforeUnload: false }).catch(() => {});
        }
      }
    }
    if (reaped > 0) log('warn', 'orphan page reaper closed leaked pages', { reaped });
    return reaped;
  };
}

function makePage() {
  return {
    removeAllListeners: jest.fn(),
    close: jest.fn(async () => {}),
  };
}

describe('orphan page reaper — source shape', () => {
  test('reaper interval is present in server source', () => {
    expect(serverSource).toContain('orphan page reaper closed leaked pages');
  });

  test('reaper skips sessions marked _closing', () => {
    expect(serverSource).toContain('if (session._closing) continue');
  });
});

describe('orphan page reaper — behaviour', () => {
  test('skips pages that are in tabGroups (registered)', () => {
    const page = makePage();
    const tabState = { page };
    const group = new Map([['tab-1', tabState]]);
    const session = {
      _closing: false,
      context: { pages: () => [page] },
      tabGroups: new Map([['grp-1', group]]),
    };
    const sessions = new Map([['user-1', session]]);
    const reaper = buildOrphanReaper();
    const reaped = reaper(sessions);
    expect(reaped).toBe(0);
    expect(page.close).not.toHaveBeenCalled();
  });

  test('closes orphan pages not in tabGroups', () => {
    const orphan = makePage();
    const registered = makePage();
    const tabState = { page: registered };
    const group = new Map([['tab-1', tabState]]);
    const session = {
      _closing: false,
      context: { pages: () => [registered, orphan] },
      tabGroups: new Map([['grp-1', group]]),
    };
    const sessions = new Map([['user-1', session]]);

    const logs = [];
    const reaper = buildOrphanReaper({ log: (...a) => logs.push(a) });
    const reaped = reaper(sessions);

    expect(reaped).toBe(1);
    expect(orphan.removeAllListeners).toHaveBeenCalledTimes(1);
    expect(orphan.close).toHaveBeenCalledWith({ runBeforeUnload: false });
    expect(registered.close).not.toHaveBeenCalled();
    expect(logs[0][1]).toContain('orphan page reaper');
  });

  test('skips sessions marked _closing', () => {
    const orphan = makePage();
    const session = {
      _closing: true,
      context: { pages: () => [orphan] },
      tabGroups: new Map(),
    };
    const sessions = new Map([['user-1', session]]);
    const reaper = buildOrphanReaper();
    expect(reaper(sessions)).toBe(0);
    expect(orphan.close).not.toHaveBeenCalled();
  });

  test('skips sessions whose context.pages() throws', () => {
    const session = {
      _closing: false,
      context: { pages: () => { throw new Error('context dead'); } },
      tabGroups: new Map(),
    };
    const sessions = new Map([['user-1', session]]);
    const reaper = buildOrphanReaper();
    expect(() => reaper(sessions)).not.toThrow();
    expect(reaper(sessions)).toBe(0);
  });

  test('counts orphans across multiple sessions', () => {
    const orphanA = makePage();
    const orphanB = makePage();
    const sessionA = {
      _closing: false,
      context: { pages: () => [orphanA] },
      tabGroups: new Map(),
    };
    const sessionB = {
      _closing: false,
      context: { pages: () => [orphanB] },
      tabGroups: new Map(),
    };
    const sessions = new Map([['user-1', sessionA], ['user-2', sessionB]]);
    const logs = [];
    const reaper = buildOrphanReaper({ log: (...a) => logs.push(a) });
    expect(reaper(sessions)).toBe(2);
    expect(logs[0][2].reaped).toBe(2);
  });

  test('no log emitted when nothing to reap', () => {
    const sessions = new Map();
    const logs = [];
    const reaper = buildOrphanReaper({ log: (...a) => logs.push(a) });
    expect(reaper(sessions)).toBe(0);
    expect(logs).toHaveLength(0);
  });
});
