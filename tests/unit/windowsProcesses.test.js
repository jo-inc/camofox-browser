import { spawn } from 'child_process';
import { once } from 'events';
import { windowsProcessEnvironment } from '../../lib/config.js';
import { isWindowsBrowserProcess, isWindowsProcessCurrent, killWindowsProcessTree, normalizeWindowsProcess, refreshWindowsProcesses, selectWindowsProcessTree, snapshotWindowsProcesses } from '../../lib/windows-processes.js';
import { snapshotBrowserProcessPids } from '../../lib/browser-processes.js';
import { snapshotOwnedBrowserProcesses } from '../../lib/process-ownership.js';
import { browserProcessTreeRssMb } from '../../lib/resources.js';

test('normalizes Windows process records and selects a complete tree', () => {
  const processes = [
    normalizeWindowsProcess({ ProcessId: 10, ParentProcessId: 1, Name: 'node.exe', CreationDate: 'a', WorkingSetSize: 100 }),
    normalizeWindowsProcess({ ProcessId: 11, ParentProcessId: 10, Name: 'camoufox.exe', CreationDate: 'b', WorkingSetSize: 200 }),
    normalizeWindowsProcess({ ProcessId: 12, ParentProcessId: 11, Name: 'firefox.exe', CreationDate: 'c', WorkingSetSize: 300 }),
    normalizeWindowsProcess({ ProcessId: 20, ParentProcessId: 1, Name: 'camoufox.exe', CreationDate: 'd', WorkingSetSize: 400 }),
  ];

  expect(selectWindowsProcessTree(10, processes).map((proc) => proc.pid)).toEqual([10, 11, 12]);
  expect(processes[1]).toMatchObject({ pid: 11, ppid: 10, startTime: 'b', workingSetSize: 200 });
  expect(isWindowsProcessCurrent(processes[1], processes)).toBe(true);
  expect(isWindowsProcessCurrent({ ...processes[1], startTime: 'reused' }, processes)).toBe(false);
});

test('Windows browser matching uses the executable identity, not arbitrary command-line text', () => {
  expect(isWindowsBrowserProcess({ name: 'camoufox.exe', cmdline: 'node fake-camoufox.exe' })).toBe(true);
  expect(isWindowsBrowserProcess({ name: 'firefox.exe', cmdline: 'node fake' })).toBe(true);
  expect(isWindowsBrowserProcess({ name: 'node.exe', cmdline: 'node camoufox-parent.exe' })).toBe(false);
  expect(isWindowsBrowserProcess({ name: 'powershell.exe', cmdline: 'firefox.exe' })).toBe(false);
});

const testOnWindows = process.platform === 'win32' ? test : test.skip;

testOnWindows('snapshots and kills only an owned browser-shaped process tree', async () => {
  const childScript = [
    "const { spawn } = require('child_process');",
    "const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)', 'camoufox-child.exe'], { stdio: 'ignore', windowsHide: true, env: {} });",
    "process.stdout.write(String(child.pid));",
    "setInterval(() => {}, 1000);",
  ].join('');
  const launcher = spawn(process.execPath, ['-e', childScript, 'camoufox-parent.exe'], {
    stdio: ['ignore', 'pipe', 'ignore'],
    windowsHide: true,
    env: windowsProcessEnvironment(),
  });

  let childPid = null;
  try {
    childPid = Number(await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('timed out waiting for child pid')), 10000);
      launcher.stdout.on('data', (data) => {
        clearTimeout(timer);
        resolve(String(data).trim());
      });
      launcher.once('error', reject);
    }));

    const processSnapshot = await refreshWindowsProcesses();
    const launcherRecord = processSnapshot.find((proc) => proc.pid === launcher.pid);
    expect(launcherRecord).toBeDefined();
    expect(launcherRecord.name.toLowerCase()).toMatch(/^(?:node|nodejs)(?:\.exe)?$/);
    const owned = snapshotOwnedBrowserProcesses(process.pid);
    expect(owned.some((proc) => proc.pid === launcher.pid)).toBe(false);
    expect(owned.some((proc) => proc.pid === childPid)).toBe(false);
    const browserPids = snapshotBrowserProcessPids({ myPid: process.pid });
    expect(browserPids).not.toContain(launcher.pid);
    expect(browserPids).not.toContain(childPid);
    expect(browserProcessTreeRssMb(launcher.pid)).toEqual(expect.any(Number));

    expect(killWindowsProcessTree(launcher.pid, { expectedStartTime: launcherRecord.startTime })).toBe(true);
    await once(launcher, 'exit');

    const deadline = Date.now() + 5000;
    while (Date.now() < deadline && snapshotWindowsProcesses().some((proc) => proc.pid === childPid)) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    expect(snapshotWindowsProcesses().some((proc) => proc.pid === childPid)).toBe(false);
  } finally {
    if (launcher.exitCode === null) killWindowsProcessTree(launcher.pid);
    if (childPid && snapshotWindowsProcesses().some((proc) => proc.pid === childPid)) {
      killWindowsProcessTree(childPid);
    }
  }
}, 20000);
