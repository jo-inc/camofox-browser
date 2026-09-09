import fs from 'fs';
import { killWindowsProcessTree, snapshotWindowsProcesses } from './windows-processes.js';

export function isBrowserProcessCmdline(cmdline) {
  return /camoufox(?:-bin)?(?:\.exe)?|firefox(?:-esr)?(?:\.exe)?|GeckoChildProcess/i.test(cmdline || '');
}

export function selectBrowserProcessVictims(entries, { myPid, excludePid = null } = {}) {
  return entries
    .filter(({ pid }) => pid !== myPid && pid !== excludePid)
    .filter(({ cmdline }) => isBrowserProcessCmdline(cmdline))
    .map(({ pid }) => pid);
}

export function snapshotBrowserProcessPids({ myPid = process.pid, excludePid = null } = {}) {
  if (process.platform === 'win32') {
    const entries = snapshotWindowsProcesses();
    return selectBrowserProcessVictims(entries, { myPid, excludePid });
  }
  if (process.platform !== 'linux') return [];
  const entries = [];
  const procDirs = fs.readdirSync('/proc').filter((dir) => /^\d+$/.test(dir));
  for (const procPid of procDirs) {
    const pid = parseInt(procPid, 10);
    try {
      const cmdline = fs.readFileSync(`/proc/${procPid}/cmdline`, 'utf8');
      entries.push({ pid, cmdline });
    } catch {
      // Process vanished or permission denied.
    }
  }
  return selectBrowserProcessVictims(entries, { myPid, excludePid });
}

export async function killProcessIds(pids, { signal = 'SIGKILL', delayMs = 300, processSnapshots = null } = {}) {
  for (const pid of pids) {
    if (process.platform === 'win32' && signal === 'SIGKILL') {
      const snapshot = processSnapshots?.find((proc) => proc.pid === pid);
      killWindowsProcessTree(pid, { expectedStartTime: snapshot?.startTime ?? null });
      continue;
    }
    try { process.kill(pid, signal); } catch { /* already dead */ }
  }
  if (pids.length > 0 && delayMs > 0) {
    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
}
