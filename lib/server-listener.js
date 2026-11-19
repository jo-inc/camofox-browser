import fs from 'fs';
import net from 'net';
import path from 'path';

const SOCKET_PROBE_TIMEOUT_MS = 1000;
const UNIX_SOCKET_PATH_LIMITS = {
  linux: 107,
  darwin: 103,
};
const STAGING_BASENAMES = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';

function socketError(message, code, cause) {
  const error = new Error(message, cause ? { cause } : undefined);
  error.code = code;
  return error;
}

function sameFile(left, right) {
  return left.dev === right.dev && left.ino === right.ino;
}

async function lstatIfExists(filePath) {
  try {
    return await fs.promises.lstat(filePath);
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

function validateUnixSocketPath(socketPath, platform = process.platform) {
  const limit = UNIX_SOCKET_PATH_LIMITS[platform] ?? UNIX_SOCKET_PATH_LIMITS.darwin;
  const length = Buffer.byteLength(socketPath);
  if (length > limit) {
    throw socketError(
      `Unix socket path is too long for ${platform} (${length} bytes; maximum ${limit}): ${socketPath}`,
      'ENAMETOOLONG',
    );
  }
}

async function validateSocketParent(socketPath, { getuid = process.getuid } = {}) {
  const parentPath = path.dirname(socketPath);
  const parent = await fs.promises.lstat(parentPath);
  if (!parent.isDirectory()) {
    throw socketError(`Unix socket parent is not a directory: ${parentPath}`, 'ENOTDIR');
  }

  if (typeof getuid === 'function') {
    const uid = getuid.call(process);
    if (parent.uid !== uid) {
      throw socketError(`Unix socket parent must be owned by the current user: ${parentPath}`, 'EACCES');
    }
  }

  if ((parent.mode & 0o077) !== 0) {
    throw socketError(`Unix socket parent must not grant access to group or others: ${parentPath}`, 'EACCES');
  }

  return parent;
}

async function probeUnixSocket(socketPath, timeoutMs = SOCKET_PROBE_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(socketPath);
    let settled = false;

    const finish = (result, error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      if (error) reject(error);
      else resolve(result);
    };

    const timer = setTimeout(() => finish('active'), timeoutMs);
    timer.unref?.();
    socket.once('connect', () => finish('active'));
    socket.once('error', (error) => {
      if (error.code === 'ECONNREFUSED') finish('stale');
      else if (error.code === 'ENOENT') finish('missing');
      else finish(null, error);
    });
  });
}

/**
 * Remove a stale Unix socket without clobbering an active listener or a
 * non-socket filesystem entry. A mode-0700 owner-controlled parent excludes
 * cross-user replacement; identity re-checks preserve same-user replacements
 * on a best-effort basis.
 */
async function removeStaleUnixSocket(socketPath, { probe = probeUnixSocket, getuid = process.getuid } = {}) {
  const parent = await validateSocketParent(socketPath, { getuid });
  const initial = await lstatIfExists(socketPath);
  if (!initial) return false;
  if (!initial.isSocket()) {
    throw socketError(`Unix socket path already exists and is not a socket: ${socketPath}`, 'EEXIST');
  }

  const state = await probe(socketPath);
  if (state === 'active') {
    throw socketError(`Unix socket is already in use: ${socketPath}`, 'EADDRINUSE');
  }
  if (state === 'missing') return false;
  if (state !== 'stale') {
    throw socketError(`Could not determine whether Unix socket is stale: ${socketPath}`, 'EADDRINUSE');
  }

  const currentParent = await validateSocketParent(socketPath, { getuid });
  if (!sameFile(parent, currentParent)) {
    throw socketError(`Unix socket parent changed while checking it: ${path.dirname(socketPath)}`, 'EEXIST');
  }
  const current = await lstatIfExists(socketPath);
  if (!current) return false;
  if (!current.isSocket() || !sameFile(initial, current)) {
    throw socketError(`Unix socket path changed while checking it: ${socketPath}`, 'EEXIST');
  }
  await fs.promises.unlink(socketPath);
  return true;
}

function waitForListen(server, ...args) {
  return new Promise((resolve, reject) => {
    const onListening = () => {
      server.off('error', onError);
      resolve();
    };
    const onError = (error) => {
      server.off('listening', onListening);
      reject(error);
    };
    server.once('listening', onListening);
    server.once('error', onError);
    server.listen(...args);
  });
}

async function listenOnStagingSocket(server, socketPath) {
  const parentPath = path.dirname(socketPath);
  const targetBasename = path.basename(socketPath);

  for (const basename of STAGING_BASENAMES) {
    if (basename === targetBasename) continue;
    const stagingPath = path.join(parentPath, basename);
    if (await lstatIfExists(stagingPath)) continue;

    try {
      await waitForListen(server, stagingPath);
      return stagingPath;
    } catch (error) {
      // Another same-user listener may have claimed this candidate after our
      // existence check. Try the next one-byte name without disturbing it.
      if (error.code === 'EADDRINUSE' || error.code === 'EEXIST') continue;
      throw error;
    }
  }

  throw socketError(`No staging pathname is available for Unix socket: ${socketPath}`, 'EADDRINUSE');
}

async function closeServer(server) {
  if (!server.listening) return;
  await new Promise((resolve) => server.close(resolve));
}

async function unlinkOwnedSocket(socketPath, identity) {
  const current = await lstatIfExists(socketPath);
  if (!current || !current.isSocket() || !sameFile(current, identity)) return false;
  await fs.promises.unlink(socketPath);
  return true;
}

async function listenOnUnixSocket(server, socketPath, mode, options = {}) {
  const platform = options.platform ?? process.platform;
  if (platform === 'win32') {
    throw socketError('Unix-domain socket listeners are not supported on Windows', 'ENOTSUP');
  }

  validateUnixSocketPath(socketPath, platform);
  const parent = await validateSocketParent(socketPath, options);
  await removeStaleUnixSocket(socketPath, options);
  const currentParent = await validateSocketParent(socketPath, options);
  if (!sameFile(parent, currentParent)) {
    throw socketError(`Unix socket parent changed before binding: ${path.dirname(socketPath)}`, 'EEXIST');
  }

  let stagingPath;
  let identity;
  let published = false;
  try {
    stagingPath = await listenOnStagingSocket(server, socketPath);
    identity = await fs.promises.lstat(stagingPath);
    if (!identity.isSocket()) {
      throw socketError(`Unix socket staging path changed while binding it: ${stagingPath}`, 'EEXIST');
    }
    await fs.promises.chmod(stagingPath, mode);
    const staged = await fs.promises.lstat(stagingPath);
    if (!staged.isSocket() || !sameFile(identity, staged)) {
      throw socketError(`Unix socket staging path changed while setting its mode: ${stagingPath}`, 'EEXIST');
    }
    const publishedParent = await validateSocketParent(socketPath, options);
    if (!sameFile(parent, publishedParent)) {
      throw socketError(`Unix socket parent changed while binding: ${path.dirname(socketPath)}`, 'EEXIST');
    }

    // link(2) publishes without replacing an entry that appeared after stale
    // cleanup. Node remains tied to stagingPath, which is removed immediately,
    // so its close hook can never unlink the public target pathname.
    await fs.promises.link(stagingPath, socketPath);
    published = true;
    const publishedIdentity = await fs.promises.lstat(socketPath);
    if (!publishedIdentity.isSocket() || !sameFile(identity, publishedIdentity)) {
      throw socketError(`Unix socket path changed while publishing it: ${socketPath}`, 'EEXIST');
    }
    const stagingRemoved = await unlinkOwnedSocket(stagingPath, identity);
    if (!stagingRemoved) {
      throw socketError(`Unix socket staging path changed while publishing it: ${stagingPath}`, 'EEXIST');
    }

    return {
      kind: 'unix',
      path: socketPath,
      mode,
      cleanup: () => unlinkOwnedSocket(socketPath, identity),
    };
  } catch (error) {
    if (published && identity) {
      await unlinkOwnedSocket(socketPath, identity).catch(() => false);
    }
    if (stagingPath && identity) {
      await unlinkOwnedSocket(stagingPath, identity).catch(() => false);
    }
    await closeServer(server).catch(() => {});
    throw error;
  }
}

async function listenOnTcp(server, port, bindHost) {
  await waitForListen(server, port, bindHost || undefined);
  const address = server.address();
  return {
    kind: 'tcp',
    port: typeof address === 'object' && address ? address.port : port,
    host: typeof address === 'object' && address ? address.address : bindHost,
    cleanup: async () => false,
  };
}

async function listenServer(server, { port, bindHost, unixSocket }) {
  if (unixSocket?.path) {
    return listenOnUnixSocket(server, unixSocket.path, unixSocket.mode);
  }
  return listenOnTcp(server, port, bindHost);
}

export {
  listenServer,
  listenOnUnixSocket,
  probeUnixSocket,
  removeStaleUnixSocket,
  unlinkOwnedSocket,
  validateSocketParent,
  validateUnixSocketPath,
};
