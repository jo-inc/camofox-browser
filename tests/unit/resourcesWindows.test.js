import { afterAll, beforeEach, describe, expect, jest, test } from '@jest/globals';
import { isWindowsBrowserProcess, normalizeWindowsProcess, selectWindowsProcessTree } from '../../lib/windows-processes.js';

const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform');
const browserPid = process.pid + 1;
const childPid = process.pid + 2;
const nestedPid = process.pid + 3;
const unrelatedPid = process.pid + 4;
const absentPid = process.pid + 5;
let processes = [];
jest.unstable_mockModule('../../lib/windows-processes.js', () => ({
  cachedWindowsProcesses: () => processes,
  isWindowsBrowserProcess,
  selectWindowsProcessTree,
}));
const { browserProcessTreeRssMb, browserProcessNameRssMb, collectResourceSnapshot } = await import('../../lib/resources.js');
const { createReporter } = await import('../../lib/reporter.js');

beforeEach(() => {
  Object.defineProperty(process, 'platform', { value: 'win32' });
  processes = [
    { pid: process.pid, ppid: 0, name: 'node.exe', workingSetSize: 100 * 1048576 },
    { pid: browserPid, ppid: process.pid, name: 'camoufox.exe', workingSetSize: 20 * 1048576 },
    { pid: childPid, ppid: browserPid, name: 'firefox.exe', workingSetSize: 30 * 1048576 },
    { pid: nestedPid, ppid: childPid, name: 'firefox.exe', workingSetSize: 10 * 1048576 },
    { pid: unrelatedPid, ppid: 0, name: 'firefox.exe', workingSetSize: 900 * 1048576 },
  ];
});
afterAll(() => Object.defineProperty(process, 'platform', originalPlatform));

describe('Windows browser working set', () => {
  test('sums the browser and nested children, excluding other trees', () => {
    expect(browserProcessTreeRssMb(browserPid)).toBe(60);
  });

  test('fallback counts only browser descendants of this server', () => {
    expect(browserProcessNameRssMb()).toBe(60);
  });

  test('snapshot uses the owned fallback when Playwright exposes no PID', () => {
    expect(collectResourceSnapshot()).toMatchObject({
      browserRssMb: 60,
      browserMemoryMetric: 'workingSet',
    });
  });

  test('crash reports label the Windows measurement as working set', async () => {
    const fetch = jest.spyOn(globalThis, 'fetch').mockResolvedValue({ ok: true, status: 200 });
    const reporter = createReporter({ crashReportEnabled: true });
    try {
      await reporter.reportCrash(new Error('synthetic test'));
      const payload = JSON.parse(fetch.mock.calls[0][1].body);
      expect(payload.body).toContain('**browser working set:** 60 MB');
    } finally {
      await reporter.stop();
      fetch.mockRestore();
    }
  });

  test.each([null, 0, -1, 1.5, '101', absentPid])('returns null for an unavailable root: %s', (pid) => {
    expect(browserProcessTreeRssMb(pid)).toBeNull();
  });

  test('does not report orphaned children when the root is missing', () => {
    processes = processes.filter(({ pid }) => pid !== browserPid);
    expect(browserProcessTreeRssMb(browserPid)).toBeNull();
    expect(browserProcessNameRssMb()).toBeNull();
  });

  test('returns null before a snapshot or after a failed refresh', () => {
    processes = [];
    expect(browserProcessTreeRssMb(browserPid)).toBeNull();
    expect(browserProcessNameRssMb()).toBeNull();
  });

  test('distinguishes a measured zero from unavailable data', () => {
    processes = [{ pid: browserPid, ppid: process.pid, name: 'camoufox.exe', workingSetSize: 0 }];
    expect(browserProcessTreeRssMb(browserPid)).toBe(0);
  });

  test.each([undefined, null, -1, 'invalid'])('does not report missing or invalid working sets as zero: %s', (workingSetSize) => {
    processes = [normalizeWindowsProcess({ pid: browserPid, ppid: process.pid, name: 'camoufox.exe', workingSetSize })];
    expect(browserProcessTreeRssMb(browserPid)).toBeNull();
    expect(browserProcessNameRssMb()).toBeNull();
  });

  test('does not report a partial tree total when a child measurement is missing', () => {
    processes[2].workingSetSize = null;
    expect(browserProcessTreeRssMb(browserPid)).toBeNull();
  });
});
