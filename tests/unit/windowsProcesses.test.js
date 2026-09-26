import cp, { spawn } from 'child_process';
import { jest } from '@jest/globals';
import { once } from 'events';
import { launchOptions } from 'camoufox-js';
import { firefox } from 'playwright-core';
import { killProcessIds } from '../../lib/browser-processes.js';
import {
  isWindowsBrowserProcess,
  isWindowsProcessCurrent,
  killWindowsProcessTree,
  normalizeWindowsProcess,
  refreshWindowsProcesses,
  selectWindowsProcessTree,
  snapshotWindowsProcesses,
} from '../../lib/windows-processes.js';
import { browserProcessTreeRssMb, collectResourceSnapshot } from '../../lib/resources.js';

const testOnWindows = process.platform === 'win32' ? test : test.skip;

testOnWindows('cached memory queries do not request process command lines', async () => {
  const query = jest.spyOn(cp, 'execFile').mockImplementation((_command, _args, _options, callback) => {
    callback(null, '[]');
  });
  try {
    await refreshWindowsProcesses();
    const script = query.mock.calls[0][1].at(-1);
    expect(script).toContain('-Property ProcessId,ParentProcessId,Name,CreationDate,WorkingSetSize');
    expect(script).not.toContain('CommandLine');
  } finally {
    query.mockRestore();
  }
});

test('selects only a root process and its descendants', () => {
  const processes = [
    normalizeWindowsProcess({ ProcessId: 10, ParentProcessId: 1, Name: 'node.exe', CreationDate: 'one' }),
    normalizeWindowsProcess({ ProcessId: 11, ParentProcessId: 10, Name: 'camoufox.exe', CreationDate: 'two' }),
    normalizeWindowsProcess({ ProcessId: 12, ParentProcessId: 11, Name: 'firefox.exe', CreationDate: 'three' }),
    normalizeWindowsProcess({ ProcessId: 20, ParentProcessId: 1, Name: 'camoufox.exe', CreationDate: 'four' }),
  ];
  expect(selectWindowsProcessTree(10, processes).map(({ pid }) => pid)).toEqual([10, 11, 12]);
  expect(isWindowsBrowserProcess(processes[1])).toBe(true);
  expect(isWindowsBrowserProcess({ name: 'node.exe', cmdline: 'camoufox.exe' })).toBe(false);
  expect(isWindowsProcessCurrent(processes[1], processes)).toBe(true);
  expect(isWindowsProcessCurrent({ ...processes[1], startTime: 'reused' }, processes)).toBe(false);
});

testOnWindows('taskkill removes a real owned process tree', async () => {
  const childScript = "const {spawn}=require('child_process');spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore',windowsHide:true});setInterval(()=>{},1000)";
  const root = spawn(process.execPath, ['-e', childScript], { stdio: 'ignore', windowsHide: true });
  try {
    const deadline = Date.now() + 10_000;
    let rootRecord;
    while (Date.now() < deadline) {
      rootRecord = snapshotWindowsProcesses().find((proc) => proc.pid === root.pid);
      if (rootRecord) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    expect(rootRecord).toBeDefined();
    expect(killWindowsProcessTree(root.pid, { expectedStartTime: rootRecord.startTime })).toBe(true);
    await once(root, 'exit');
    expect(snapshotWindowsProcesses().some((proc) => proc.pid === root.pid)).toBe(false);
  } finally {
    if (root.exitCode === null) killWindowsProcessTree(root.pid);
  }
}, 20_000);

async function waitFor(condition, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('condition was not met before timeout');
}

testOnWindows('production cleanup kills a real Camoufox process tree', async () => {
  let browser;
  try {
    const beforeLaunch = snapshotWindowsProcesses();
    const existingPids = new Set(beforeLaunch.map((proc) => proc.pid));
    browser = await firefox.launch(await launchOptions({ headless: true, os: 'windows' }));
    await waitFor(() => snapshotWindowsProcesses().some((proc) => isWindowsBrowserProcess(proc) && !existingPids.has(proc.pid)));

    const snapshot = snapshotWindowsProcesses();
    const launchedBrowsers = snapshot.filter((proc) => isWindowsBrowserProcess(proc) && !existingPids.has(proc.pid));
    const roots = launchedBrowsers.filter((proc) => !launchedBrowsers.some((candidate) => candidate.pid === proc.ppid));
    expect(roots).toHaveLength(1);
    const root = roots[0];
    const ownedPids = selectWindowsProcessTree(root.pid, snapshot).map((proc) => proc.pid);
    expect(ownedPids).toContain(root.pid);

    await refreshWindowsProcesses();
    expect(browserProcessTreeRssMb(root.pid)).toBeGreaterThan(0);
    const resources = collectResourceSnapshot();
    expect(resources.browserRssMb).toBeGreaterThan(0);
    expect(resources.browserMemoryMetric).toBe('workingSet');

    await killProcessIds([root.pid], { delayMs: 0, processSnapshots: snapshot });
    await waitFor(() => !browser.isConnected());
    await waitFor(() => {
      const current = snapshotWindowsProcesses();
      return ownedPids.every((pid) => !current.some((proc) => proc.pid === pid));
    });
  } finally {
    await browser?.close().catch(() => {});
  }
}, 30_000);
