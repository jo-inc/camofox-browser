import fs from 'fs';
import path from 'path';
import { isWindowsBrowserProcess, isWindowsProcessCurrent, selectWindowsProcessTree, snapshotWindowsProcesses } from './windows-processes.js';

const BROWSER_PROCESS_RE = /camoufox-bin|\/usr\/bin\/Xvfb\b/;

function readProcess(procRoot, pid) {
  const status = fs.readFileSync(`${procRoot}/${pid}/status`, 'utf8');
  const ppid = Number(status.match(/^PPid:\s+(\d+)/m)?.[1]);
  // The comm field is parenthesized and may itself contain spaces or `)`, so
  // fields cannot be found with a plain whitespace split. starttime is field
  // 22 overall, or index 19 in the suffix beginning with field 3 (state).
  const stat = fs.readFileSync(`${procRoot}/${pid}/stat`, 'utf8');
  const commEnd = stat.lastIndexOf(')');
  if (commEnd < 0) throw new Error(`invalid proc stat for ${pid}`);
  const startTime = stat.slice(commEnd + 2).trim().split(/\s+/)[19];
  if (startTime === undefined) throw new Error(`missing starttime for ${pid}`);
  const cmdline = fs.readFileSync(`${procRoot}/${pid}/cmdline`, 'utf8');
  return { pid: Number(pid), ppid, startTime, cmdline };
}

/** Snapshot browser/Xvfb descendants owned by one server process. */
export function snapshotOwnedBrowserProcesses(rootPid, procRoot = '/proc') {
  if (process.platform === 'win32' && procRoot === '/proc') {
    return selectWindowsProcessTree(rootPid, snapshotWindowsProcesses()).filter(isWindowsBrowserProcess);
  }
  if (process.platform !== 'linux' && procRoot === '/proc') return [];
  const processes = [];
  for (const entry of fs.readdirSync(procRoot)) {
    if (!/^\d+$/.test(entry)) continue;
    try { processes.push(readProcess(procRoot, entry)); } catch { /* process vanished */ }
  }

  const descendants = new Set([Number(rootPid)]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const proc of processes) {
      if (!descendants.has(proc.pid) && descendants.has(proc.ppid)) {
        descendants.add(proc.pid);
        changed = true;
      }
    }
  }
  return processes.filter(proc => descendants.has(proc.pid) && BROWSER_PROCESS_RE.test(proc.cmdline));
}

export function profilePathsFromProcessSnapshot(snapshot) {
  const profiles = new Set();
  for (const { cmdline = '' } of snapshot) {
    const args = cmdline.split('\0');
    for (let index = 0; index < args.length; index++) {
      const arg = args[index];
      let profile;
      if (arg === '-profile' || arg === '--profile') profile = args[index + 1];
      else if (arg.startsWith('-profile=') || arg.startsWith('--profile=')) profile = arg.slice(arg.indexOf('=') + 1);
      if (profile) profiles.add(path.resolve(profile));
    }
  }
  return profiles;
}

/** Only ESRCH proves absence; missing ownership or uncertain inspection preserves profiles. */
export function completedBrowserProfilePaths(snapshot, closed, checkPid = process.kill) {
  const exited = closed && snapshot.length > 0 && snapshot.every(({ pid }) => {
    if (!Number.isSafeInteger(pid) || pid <= 0) return false;
    try { checkPid(pid, 0); return false; }
    catch (error) { return error.code === 'ESRCH'; }
  });
  return exited ? profilePathsFromProcessSnapshot(snapshot) : new Set();
}

/** Return only snapshot members that are still the same OS processes. */
export function survivingOwnedBrowserProcesses(snapshot, procRoot = '/proc') {
  if (process.platform === 'win32' && procRoot === '/proc') {
    const processes = snapshotWindowsProcesses();
    return snapshot.filter((proc) => isWindowsProcessCurrent(proc, processes));
  }
  return snapshot.filter(proc => {
    try { return readProcess(procRoot, proc.pid).startTime === proc.startTime; } catch { return false; }
  });
}
