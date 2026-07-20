import { afterEach, describe, expect, test } from '@jest/globals';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const library = path.join(here, 'vnc-watcher-lib.sh');
const tempDirs = [];
const servers = [];

function shell(script, args = [], input = '') {
  return execFileSync('sh', ['-c', `. "$1"; ${script}`, 'sh', library, ...args], {
    input,
    encoding: 'utf8',
  }).trim();
}

async function unixSocket(socketPath) {
  const server = net.createServer();
  servers.push(server);
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(socketPath, resolve);
  });
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise((resolve) => server.close(resolve))));
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('vnc watcher helpers', () => {
  test('finds only the owned -displayfd Xvfb process', () => {
    const processes = [
      '100 7 /usr/bin/Xvfb -displayfd 3 -screen 0 1920x1080x24',
      '200 8 /usr/bin/Xvfb -displayfd 3 -screen 0 1920x1080x24',
      '300 7 /usr/bin/other -screen 0 1920x1080x24',
    ].join('\n');

    expect(shell('find_owned_xvfb_pid 7 1920x1080x24', [], processes)).toBe('100');
  });

  test('maps the owned Xvfb PID through its lock file and real Unix socket', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'camofox-vnc-test-'));
    tempDirs.push(root);
    const sockets = path.join(root, '.X11-unix');
    fs.mkdirSync(sockets);
    fs.writeFileSync(path.join(root, '.X0-lock'), '111\n');
    fs.writeFileSync(path.join(root, '.X7-lock'), '222\n');
    await unixSocket(path.join(sockets, 'X0'));
    await unixSocket(path.join(sockets, 'X7'));

    expect(shell('display_for_xvfb_pid "$2" "$3" "$4"', ['222', root, sockets])).toBe(':7');
  });

  test('maps lock-free -displayfd sockets through the owned PID in procfs', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'camofox-vnc-test-'));
    tempDirs.push(root);
    const sockets = path.join(root, '.X11-unix');
    const procRoot = path.join(root, 'proc');
    const fdDir = path.join(procRoot, '222', 'fd');
    fs.mkdirSync(sockets);
    fs.mkdirSync(fdDir, { recursive: true });
    fs.mkdirSync(path.join(procRoot, 'net'));
    await unixSocket(path.join(sockets, 'X7'));
    fs.symlinkSync('socket:[98765]', path.join(fdDir, '5'));
    fs.writeFileSync(
      path.join(procRoot, 'net', 'unix'),
      `Num RefCount Protocol Flags Type St Inode Path\n000: 2 0 00010000 1 01 98765 ${sockets}/X7\n`,
    );

    expect(shell('display_for_xvfb_pid "$2" "$3" "$4" "$5"', ['222', root, sockets, procRoot])).toBe(':7');
  });

  test('rejects another process lock and non-socket files', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'camofox-vnc-test-'));
    tempDirs.push(root);
    const sockets = path.join(root, '.X11-unix');
    fs.mkdirSync(sockets);
    fs.writeFileSync(path.join(root, '.X0-lock'), '111\n');
    fs.writeFileSync(path.join(sockets, 'X0'), 'not a socket');

    expect(shell('display_for_xvfb_pid "$2" "$3" "$4"', ['111', root, sockets])).toBe('');
    expect(shell('display_for_xvfb_pid "$2" "$3" "$4"', ['222', root, sockets])).toBe('');
  });

  test('requests reattachment only after the tracked process exits', () => {
    expect(shell('if x11vnc_needs_reattach "$2"; then echo yes; else echo no; fi', [String(process.pid)])).toBe('no');
    expect(shell('if x11vnc_needs_reattach 99999999; then echo yes; else echo no; fi')).toBe('yes');
    expect(shell('if x11vnc_needs_reattach ""; then echo yes; else echo no; fi')).toBe('no');
  });
});
