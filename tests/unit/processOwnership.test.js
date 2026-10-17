import fs from 'fs';
import os from 'os';
import path from 'path';
import { snapshotOwnedBrowserProcesses, survivingOwnedBrowserProcesses, profilePathsFromProcessSnapshot, completedBrowserProfilePaths } from '../../lib/process-ownership.js';

test('profile cleanup requires completed close and confirmed absence of every captured PID', () => {
  const snapshot = [{ pid: 101, cmdline: 'camoufox-bin\0-profile\0/tmp/camoufox-owned' }];
  const gone = () => { throw Object.assign(new Error('gone'), { code: 'ESRCH' }); };
  const uncertain = () => { throw Object.assign(new Error('denied'), { code: 'EPERM' }); };
  expect([...completedBrowserProfilePaths(snapshot, true, gone)]).toEqual([path.resolve('/tmp/camoufox-owned')]);
  expect(completedBrowserProfilePaths(snapshot, false, gone).size).toBe(0);
  expect(completedBrowserProfilePaths([], true, gone).size).toBe(0);
  expect(completedBrowserProfilePaths(snapshot, true, () => {}).size).toBe(0);
  expect(completedBrowserProfilePaths(snapshot, true, uncertain).size).toBe(0);
  expect(completedBrowserProfilePaths([...snapshot, { pid: 202 }], true,
    pid => { if (pid === 101) return gone(); }).size).toBe(0);
  expect(completedBrowserProfilePaths([{ pid: 101 }], true, gone).size).toBe(0);
});

function proc(root, pid, ppid, cmdline, startTime = '10', comm = 'test') {
  const dir = path.join(root, String(pid));
  fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, 'status'), `Name:\ttest\nPPid:\t${ppid}\n`);
  fs.writeFileSync(path.join(dir, 'stat'), `${pid} (${comm}) S ${ppid} 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 ${startTime}`);
  fs.writeFileSync(path.join(dir, 'cmdline'), cmdline);
}

test('profile path extraction accepts separate and equals-form profile arguments', () => {
  const profiles = profilePathsFromProcessSnapshot([
    { cmdline: '/cache/camoufox-bin\0-profile\0/tmp/playwright_firefoxdev_profile-live\0-foreground' },
    { cmdline: '/cache/camoufox-bin\0--profile=/tmp/camoufox-live' },
    { cmdline: '/cache/camoufox-bin\0-foreground' },
  ]);

  expect([...profiles]).toEqual([
    path.resolve('/tmp/playwright_firefoxdev_profile-live'),
    path.resolve('/tmp/camoufox-live'),
  ]);
});


test('cleanup snapshot never adopts another scoped server browser', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'camofox-proc-'));
  proc(root, 100, 1, 'node\0server.js');
  proc(root, 101, 100, '/usr/bin/Xvfb\0:10');
  proc(root, 102, 100, '/cache/camoufox-bin\0-foreground');
  proc(root, 200, 1, 'node\0server.js');
  proc(root, 201, 200, '/usr/bin/Xvfb\0:20');
  proc(root, 202, 200, '/cache/camoufox-bin\0-foreground');

  expect(snapshotOwnedBrowserProcesses(100, root).map(p => p.pid)).toEqual([101, 102]);
  expect(survivingOwnedBrowserProcesses(snapshotOwnedBrowserProcesses(100, root), root).map(p => p.pid))
    .toEqual([101, 102]);
  fs.rmSync(root, { recursive: true, force: true });
});

test('only captured descendants survive reparenting; unrelated PID 1 browsers do not', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'camofox-proc-'));
  proc(root, 100, 1, 'node\0server.js');
  proc(root, 101, 100, '/cache/camoufox-bin', '10');
  proc(root, 202, 1, '/cache/camoufox-bin', '20');
  const snapshot = snapshotOwnedBrowserProcesses(100, root);

  fs.writeFileSync(path.join(root, '101', 'status'), 'Name:\ttest\nPPid:\t1\n');

  expect(snapshot.map(p => p.pid)).toEqual([101]);
  expect(survivingOwnedBrowserProcesses(snapshot, root).map(p => p.pid)).toEqual([101]);
  fs.rmSync(root, { recursive: true, force: true });
});

test('pid reuse is not mistaken for an owned survivor', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'camofox-proc-'));
  proc(root, 100, 1, 'node\0server.js');
  proc(root, 101, 100, '/cache/camoufox-bin', '10');
  const snapshot = snapshotOwnedBrowserProcesses(100, root);
  fs.writeFileSync(path.join(root, '101', 'stat'), '101 (test) S 100 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 99');
  expect(survivingOwnedBrowserProcesses(snapshot, root)).toEqual([]);
  fs.rmSync(root, { recursive: true, force: true });
});

test('process start time parsing tolerates spaces and parentheses in comm', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'camofox-proc-'));
  proc(root, 100, 1, 'node\0server.js');
  proc(root, 101, 100, '/cache/camoufox-bin', '42', 'Camoufox Worker (GPU)');
  const snapshot = snapshotOwnedBrowserProcesses(100, root);
  expect(snapshot.map(p => [p.pid, p.startTime])).toEqual([[101, '42']]);
  fs.rmSync(root, { recursive: true, force: true });
});
