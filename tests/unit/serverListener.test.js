import { afterEach, describe, expect, jest, test } from '@jest/globals';
import fs from 'fs';
import http from 'http';
import os from 'os';
import path from 'path';
import {
  listenOnUnixSocket,
  listenServer,
  removeStaleUnixSocket,
} from '../../lib/server-listener.js';

const dirs = [];
const servers = [];

function tempSocket(name = 'camofox.sock') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'camofox-listener-'));
  dirs.push(dir);
  return path.join(dir, name);
}

function createServer() {
  const server = http.createServer((_req, res) => res.end('ok'));
  servers.push(server);
  return server;
}

function rawListen(server, target) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(target, resolve);
  });
}

function close(server) {
  if (!server.listening) return Promise.resolve();
  return new Promise((resolve) => server.close(resolve));
}

async function makeStaleSocket(target) {
  const original = `${target}.original`;
  const server = createServer();
  await rawListen(server, original);
  await fs.promises.rename(original, target);
  await close(server);
  expect((await fs.promises.lstat(target)).isSocket()).toBe(true);
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => close(server)));
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('Unix socket listener', () => {
  test('replaces a stale socket and listens only on the configured Unix path', async () => {
    const socketPath = tempSocket();
    await makeStaleSocket(socketPath);
    const server = createServer();

    const listener = await listenServer(server, {
      port: 0,
      bindHost: '127.0.0.1',
      unixSocket: { path: socketPath, mode: 0o600 },
    });

    expect(listener.kind).toBe('unix');
    expect(typeof server.address()).toBe('string');
    expect(path.dirname(server.address())).toBe(path.dirname(socketPath));
    expect(Buffer.byteLength(path.basename(server.address()))).toBe(1);
    expect(server.address()).not.toBe(socketPath);
    expect(await fs.promises.readdir(path.dirname(socketPath))).toEqual([path.basename(socketPath)]);
    await expect(new Promise((resolve, reject) => {
      const request = http.get({ socketPath, path: '/' }, (response) => {
        let body = '';
        response.on('data', (chunk) => { body += chunk; });
        response.on('end', () => resolve(body));
      });
      request.on('error', reject);
    })).resolves.toBe('ok');
  });

  test('does not clobber an active socket', async () => {
    const socketPath = tempSocket();
    const active = createServer();
    await rawListen(active, socketPath);
    const original = await fs.promises.lstat(socketPath);

    await expect(removeStaleUnixSocket(socketPath)).rejects.toMatchObject({ code: 'EADDRINUSE' });

    const current = await fs.promises.lstat(socketPath);
    expect(current.ino).toBe(original.ino);
  });

  test.each(['regular file', 'symlink'])('refuses a %s at the socket path', async (kind) => {
    const socketPath = tempSocket();
    if (kind === 'symlink') {
      const target = `${socketPath}.target`;
      fs.writeFileSync(target, 'keep');
      fs.symlinkSync(target, socketPath);
    } else {
      fs.writeFileSync(socketPath, 'keep');
    }

    await expect(removeStaleUnixSocket(socketPath)).rejects.toMatchObject({ code: 'EEXIST' });
    expect((await fs.promises.lstat(socketPath)).isSocket()).toBe(false);
  });

  test('preserves a path replaced during stale-socket probing', async () => {
    const socketPath = tempSocket();
    await makeStaleSocket(socketPath);
    const originalPath = `${socketPath}.checked`;

    await expect(removeStaleUnixSocket(socketPath, {
      probe: async () => {
        await fs.promises.rename(socketPath, originalPath);
        await fs.promises.writeFile(socketPath, 'replacement');
        return 'stale';
      },
    })).rejects.toMatchObject({ code: 'EEXIST' });

    expect(await fs.promises.readFile(socketPath, 'utf8')).toBe('replacement');
    expect((await fs.promises.lstat(originalPath)).isSocket()).toBe(true);
  });

  test('publishes the socket with the configured mode', async () => {
    const socketPath = tempSocket();
    const server = createServer();

    await listenOnUnixSocket(server, socketPath, 0o660);

    expect((await fs.promises.stat(socketPath)).mode & 0o777).toBe(0o660);
  });

  test('does not clobber a replacement created immediately before publication', async () => {
    const socketPath = tempSocket();
    const server = createServer();
    const originalLink = fs.promises.link.bind(fs.promises);
    const link = jest.spyOn(fs.promises, 'link').mockImplementationOnce(async (stagingPath, targetPath) => {
      expect(targetPath).toBe(socketPath);
      expect(path.dirname(stagingPath)).toBe(path.dirname(socketPath));
      expect(Buffer.byteLength(path.basename(stagingPath))).toBe(1);
      await fs.promises.writeFile(socketPath, 'replacement');
      return originalLink(stagingPath, targetPath);
    });

    await expect(listenOnUnixSocket(server, socketPath, 0o600))
      .rejects.toMatchObject({ code: 'EEXIST' });

    link.mockRestore();
    expect(server.listening).toBe(false);
    expect(await fs.promises.readFile(socketPath, 'utf8')).toBe('replacement');
    expect(await fs.promises.readdir(path.dirname(socketPath))).toEqual([path.basename(socketPath)]);
  });

  test('fails cleanly when every staging basename is occupied', async () => {
    const socketPath = tempSocket('0');
    const parent = path.dirname(socketPath);
    const occupied = '123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
    for (const basename of occupied) {
      await fs.promises.writeFile(path.join(parent, basename), basename);
    }
    const server = createServer();

    await expect(listenOnUnixSocket(server, socketPath, 0o600))
      .rejects.toMatchObject({ code: 'EADDRINUSE', message: expect.stringContaining('No staging pathname') });

    expect(server.listening).toBe(false);
    expect(fs.existsSync(socketPath)).toBe(false);
    expect(await fs.promises.readdir(parent)).toHaveLength(occupied.length);
  });

  test('cleans up its socket but preserves a replacement through cleanup and close', async () => {
    const firstPath = tempSocket('first.sock');
    const firstServer = createServer();
    const first = await listenOnUnixSocket(firstServer, firstPath, 0o600);
    await expect(first.cleanup()).resolves.toBe(true);
    expect(firstServer.listening).toBe(true);
    await close(firstServer);
    expect(fs.existsSync(firstPath)).toBe(false);

    const secondPath = tempSocket('second.sock');
    const secondServer = createServer();
    const second = await listenOnUnixSocket(secondServer, secondPath, 0o600);
    await fs.promises.rename(secondPath, `${secondPath}.old`);
    await fs.promises.writeFile(secondPath, 'replacement');
    await expect(second.cleanup()).resolves.toBe(false);
    expect(secondServer.listening).toBe(true);
    expect(await fs.promises.readFile(secondPath, 'utf8')).toBe('replacement');
    await close(secondServer);
    expect(await fs.promises.readFile(secondPath, 'utf8')).toBe('replacement');
  });

  test('requires an owner-controlled existing parent directory', async () => {
    const traversablePath = tempSocket('traversable.sock');
    await fs.promises.chmod(path.dirname(traversablePath), 0o710);
    await expect(listenOnUnixSocket(createServer(), traversablePath, 0o600))
      .rejects.toMatchObject({ code: 'EACCES', message: expect.stringContaining('must not grant access') });
    expect(fs.existsSync(traversablePath)).toBe(false);
    await fs.promises.chmod(path.dirname(traversablePath), 0o700);

    const writablePath = tempSocket('writable.sock');
    await fs.promises.chmod(path.dirname(writablePath), 0o720);
    await expect(listenOnUnixSocket(createServer(), writablePath, 0o600))
      .rejects.toMatchObject({ code: 'EACCES', message: expect.stringContaining('must not grant access') });
    expect(fs.existsSync(writablePath)).toBe(false);
    await fs.promises.chmod(path.dirname(writablePath), 0o700);

    const wrongOwnerPath = tempSocket('wrong-owner.sock');
    const uid = typeof process.getuid === 'function' ? process.getuid() : 1000;
    await expect(listenOnUnixSocket(createServer(), wrongOwnerPath, 0o600, { getuid: () => uid + 1 }))
      .rejects.toMatchObject({ code: 'EACCES', message: expect.stringContaining('owned by the current user') });
    expect(fs.existsSync(wrongOwnerPath)).toBe(false);
  });

  test.each([
    ['linux', 107],
    ['darwin', 103],
  ])('rejects %s socket paths longer than %i encoded bytes before bind', async (platform, limit) => {
    const base = tempSocket('placeholder');
    const parent = path.dirname(base);
    const prefixBytes = Buffer.byteLength(`${parent}${path.sep}`);
    const socketPath = path.join(parent, 'é'.repeat(Math.ceil((limit + 1 - prefixBytes) / 2)));
    expect(Buffer.byteLength(socketPath)).toBeGreaterThan(limit);

    await expect(listenOnUnixSocket(createServer(), socketPath, 0o600, { platform }))
      .rejects.toMatchObject({ code: 'ENAMETOOLONG' });
    expect(await fs.promises.readdir(parent)).toEqual([]);
  });

  test('closes and unlinks the bound socket if chmod fails', async () => {
    const socketPath = tempSocket();
    const server = createServer();
    const failure = Object.assign(new Error('chmod denied'), { code: 'EPERM' });
    const chmod = jest.spyOn(fs.promises, 'chmod').mockRejectedValueOnce(failure);

    await expect(listenOnUnixSocket(server, socketPath, 0o600)).rejects.toBe(failure);

    expect(server.listening).toBe(false);
    expect(fs.existsSync(socketPath)).toBe(false);
    chmod.mockRestore();
  });

  test('keeps the existing TCP host and port behavior when no socket is configured', async () => {
    const server = createServer();

    const listener = await listenServer(server, {
      port: 0,
      bindHost: '127.0.0.1',
      unixSocket: { path: '', mode: 0o600 },
    });

    expect(listener).toMatchObject({ kind: 'tcp', host: '127.0.0.1' });
    expect(listener.port).toBeGreaterThan(0);
    expect(server.address()).toMatchObject({ address: '127.0.0.1', port: listener.port });
  });

  test('returns a clear error on Windows', async () => {
    const socketPath = tempSocket();
    await expect(listenOnUnixSocket(createServer(), socketPath, 0o600, { platform: 'win32' }))
      .rejects.toMatchObject({ code: 'ENOTSUP', message: expect.stringContaining('not supported on Windows') });
  });
});
