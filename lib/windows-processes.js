import cp from 'child_process';

const WINDOWS_ENV_KEYS = [
  'COMSPEC', 'ComSpec', 'SystemRoot', 'SystemDrive', 'WINDIR',
  'Path', 'PATHEXT', 'TEMP', 'TMP', 'PSModulePath',
];

const WINDOWS_PROCESS_QUERY = [
  "$ErrorActionPreference = 'Stop';",
  'Get-CimInstance -ClassName Win32_Process',
  '| Select-Object ProcessId,ParentProcessId,Name,CommandLine,CreationDate,WorkingSetSize',
  '| ConvertTo-Json -Compress',
].join(' ');

function childEnvironment() {
  const env = {};
  for (const key of WINDOWS_ENV_KEYS) {
    if (process.env[key]) env[key] = process.env[key];
  }
  return env;
}

function execWindows(command, args, options = {}) {
  return cp.execFileSync(command, args, {
    ...options,
    env: childEnvironment(),
    windowsHide: true,
  });
}

export function normalizeWindowsProcess(raw) {
  const pid = Number(raw?.ProcessId ?? raw?.pid);
  const ppid = Number(raw?.ParentProcessId ?? raw?.ppid);
  if (!Number.isInteger(pid) || pid <= 0 || !Number.isInteger(ppid) || ppid < 0) return null;

  const startTime = raw?.CreationDate ?? raw?.startTime;
  const workingSetSize = Number(raw?.WorkingSetSize ?? raw?.workingSetSize);
  return {
    pid,
    ppid,
    cmdline: String(raw?.CommandLine ?? raw?.cmdline ?? ''),
    name: String(raw?.Name ?? raw?.name ?? ''),
    startTime: startTime == null ? '' : String(startTime),
    workingSetSize: Number.isFinite(workingSetSize) && workingSetSize >= 0 ? workingSetSize : 0,
  };
}

export function snapshotWindowsProcesses() {
  if (process.platform !== 'win32') return [];

  let parsed;
  try {
    const output = execWindows(
      'powershell.exe',
      ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', WINDOWS_PROCESS_QUERY],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000, maxBuffer: 8 * 1024 * 1024 },
    );
    parsed = JSON.parse(String(output).trim());
  } catch {
    return [];
  }

  const records = Array.isArray(parsed) ? parsed : [parsed];
  return records.map(normalizeWindowsProcess).filter(Boolean);
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
  if (!processRecord || !processRecord.startTime) return false;
  const current = processes.find((candidate) => candidate.pid === processRecord.pid);
  return !!current && current.startTime === processRecord.startTime;
}

export function killWindowsProcessTree(pid, { expectedStartTime = null } = {}) {
  if (process.platform !== 'win32' || !Number.isInteger(pid) || pid <= 1) return false;
  if (expectedStartTime != null) {
    const current = snapshotWindowsProcesses().find((candidate) => candidate.pid === pid);
    if (!current || current.startTime !== String(expectedStartTime)) return false;
  }

  try {
    execWindows('taskkill.exe', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}
