import fs from 'fs';

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

/** Return only snapshot members that are still the same OS processes. */
export function survivingOwnedBrowserProcesses(snapshot, procRoot = '/proc') {
  return snapshot.filter(proc => {
    try { return readProcess(procRoot, proc.pid).startTime === proc.startTime; } catch { return false; }
  });
}
