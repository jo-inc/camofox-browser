import cp from 'child_process';
import { windowsProcessEnvironment } from './config.js';

function windowsProcessQueryArgs(fields) {
  const query = [
    "$ErrorActionPreference = 'Stop';",
    `Get-CimInstance -ClassName Win32_Process -Property ${fields}`,
    `| Select-Object ${fields}`,
    '| ConvertTo-Json -Compress',
  ].join(' ');
  return ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', query];
}
const WINDOWS_PROCESS_QUERY_ARGS = windowsProcessQueryArgs('ProcessId,ParentProcessId,Name,CommandLine,CreationDate,WorkingSetSize');
const WINDOWS_RESOURCE_QUERY_ARGS = windowsProcessQueryArgs('ProcessId,ParentProcessId,Name,CreationDate,WorkingSetSize');
const WINDOWS_BROWSER_PROCESS_NAMES = new Set(['camoufox.exe', 'camoufox-bin.exe', 'firefox.exe', 'firefox-esr.exe']);

let windowsProcessCache = null;
let windowsProcessRefresh = null;

function execWindows(command, args, options = {}) {
  return cp.execFileSync(command, args, { ...options, env: windowsProcessEnvironment(), windowsHide: true });
}

function parseWindowsProcesses(output) {
  try {
    const parsed = JSON.parse(String(output).trim());
    return (Array.isArray(parsed) ? parsed : [parsed]).map(normalizeWindowsProcess).filter(Boolean);
  } catch {
    return [];
  }
}

function queryWindowsProcessesAsync() {
  return new Promise((resolve) => {
    cp.execFile('powershell.exe', WINDOWS_RESOURCE_QUERY_ARGS, {
      encoding: 'utf8', windowsHide: true, env: windowsProcessEnvironment(), timeout: 5000, maxBuffer: 8 * 1024 * 1024,
    }, (error, stdout) => resolve(error ? [] : parseWindowsProcesses(stdout)));
  });
}

export function normalizeWindowsProcess(raw) {
  const pid = Number(raw?.ProcessId ?? raw?.pid);
  const ppid = Number(raw?.ParentProcessId ?? raw?.ppid);
  if (!Number.isInteger(pid) || pid <= 0 || !Number.isInteger(ppid) || ppid < 0) return null;
  const workingSetSize = Number(raw?.WorkingSetSize ?? raw?.workingSetSize ?? NaN);
  return {
    pid, ppid,
    cmdline: String(raw?.CommandLine ?? raw?.cmdline ?? ''),
    name: String(raw?.Name ?? raw?.name ?? ''),
    startTime: raw?.CreationDate == null && raw?.startTime == null ? '' : String(raw.CreationDate ?? raw.startTime),
    workingSetSize: Number.isFinite(workingSetSize) && workingSetSize >= 0 ? workingSetSize : null,
  };
}

export function snapshotWindowsProcesses() {
  if (process.platform !== 'win32') return [];
  try {
    return parseWindowsProcesses(execWindows('powershell.exe', WINDOWS_PROCESS_QUERY_ARGS, {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000, maxBuffer: 8 * 1024 * 1024,
    }));
  } catch {
    return [];
  }
}

export function refreshWindowsProcesses() {
  if (process.platform !== 'win32') return Promise.resolve([]);
  if (windowsProcessRefresh) return windowsProcessRefresh;
  windowsProcessRefresh = queryWindowsProcessesAsync().then((processes) => {
    windowsProcessCache = processes;
    return processes;
  }).finally(() => { windowsProcessRefresh = null; });
  return windowsProcessRefresh;
}

export function cachedWindowsProcesses() { return windowsProcessCache || []; }

export function isWindowsBrowserProcess(processRecord) {
  return WINDOWS_BROWSER_PROCESS_NAMES.has(String(processRecord?.name ?? processRecord ?? '').trim().toLowerCase());
}

export function selectWindowsProcessTree(rootPid, processes) {
  const root = Number(rootPid);
  if (!Number.isInteger(root) || root <= 0 || !Array.isArray(processes)) return [];
  const descendants = new Set([root]);
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
  return processes.filter((proc) => descendants.has(proc.pid));
}

export function isWindowsProcessCurrent(processRecord, processes = snapshotWindowsProcesses()) {
  if (!processRecord?.startTime) return false;
  const current = processes.find((candidate) => candidate.pid === processRecord.pid);
  return !!current && current.startTime === processRecord.startTime;
}

export function killWindowsProcessTree(pid, { expectedStartTime = null } = {}) {
  if (process.platform !== 'win32' || !Number.isInteger(pid) || pid <= 1) return false;
  if (expectedStartTime != null && !isWindowsProcessCurrent({ pid, startTime: String(expectedStartTime) })) return false;
  try {
    execWindows('taskkill.exe', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}
