import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { jest } from '@jest/globals';
import {
  getUserPersistencePaths,
  loadPersistedStorageState,
  persistStorageState,
} from '../../lib/persistence.js';
import { parseStorageKey } from '../../lib/storage-crypto.js';

const KEY = crypto.randomBytes(32);
const OTHER_KEY = crypto.randomBytes(32);

const SAMPLE_STATE = {
  cookies: [{ name: 'session', value: 'SECRET-COOKIE-VALUE', domain: '.example.com', path: '/' }],
  origins: [{ origin: 'https://app.example.com', localStorage: [{ name: 'token', value: 'SECRET-LOCAL-VALUE' }] }],
};

function contextReturning(state) {
  return {
    storageState: jest.fn(async () => state),
  };
}

describe('encrypted profile persistence', () => {
  let tmpDir;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'camofox-persistence-'));
  });

  afterEach(async () => {
    if (tmpDir) await fs.rm(tmpDir, { recursive: true, force: true });
  });

  test('getUserPersistencePaths is deterministic and stays under root', () => {
    const first = getUserPersistencePaths(tmpDir, 'agent/profile:default');
    const second = getUserPersistencePaths(tmpDir, 'agent/profile:default');

    expect(first).toEqual(second);
    expect(first.userDir.startsWith(tmpDir)).toBe(true);
    expect(first.storageStatePath.startsWith(first.userDir)).toBe(true);
    expect(first.metaPath.startsWith(first.userDir)).toBe(true);
    expect(path.basename(first.userDir)).not.toContain('/');
    expect(path.basename(first.userDir)).not.toContain(':');
  });

  test('load returns undefined when no state exists', async () => {
    await expect(loadPersistedStorageState(tmpDir, 'user-1', undefined, KEY)).resolves.toBeUndefined();
  });

  test('persist then load returns the same state object', async () => {
    const result = await persistStorageState({
      profileDir: tmpDir,
      userId: 'user-1',
      context: contextReturning(SAMPLE_STATE),
      logger: { warn: jest.fn() },
      storageKey: KEY,
    });
    expect(result.persisted).toBe(true);

    const loaded = await loadPersistedStorageState(tmpDir, 'user-1', undefined, KEY);
    expect(loaded).toEqual(SAMPLE_STATE);
  });

  test('the file on disk contains no readable cookie or storage values', async () => {
    const result = await persistStorageState({
      profileDir: tmpDir,
      userId: 'user-1',
      context: contextReturning(SAMPLE_STATE),
      logger: { warn: jest.fn() },
      storageKey: KEY,
    });

    const onDisk = await fs.readFile(result.storageStatePath);
    expect(onDisk.toString('utf8')).not.toContain('SECRET-COOKIE-VALUE');
    expect(onDisk.toString('utf8')).not.toContain('SECRET-LOCAL-VALUE');
    expect(onDisk.subarray(0, 4).toString('ascii')).toBe('CFX1');
  });

  test('metadata never includes cookie or storage values', async () => {
    const result = await persistStorageState({
      profileDir: tmpDir,
      userId: 'user-1',
      context: contextReturning(SAMPLE_STATE),
      logger: { warn: jest.fn() },
      storageKey: KEY,
    });
    const meta = await fs.readFile(result.metaPath, 'utf8');
    expect(meta).not.toContain('SECRET');
    expect(JSON.parse(meta).userId).toBe('user-1');
  });

  test('without a storage key nothing is written and nothing is loaded', async () => {
    const result = await persistStorageState({
      profileDir: tmpDir,
      userId: 'user-1',
      context: contextReturning(SAMPLE_STATE),
      logger: { warn: jest.fn() },
      storageKey: null,
    });
    expect(result).toEqual({ persisted: false, reason: 'no_storage_key' });
    await expect(fs.readdir(tmpDir)).resolves.toEqual([]);
    await expect(loadPersistedStorageState(tmpDir, 'user-1', undefined, null)).resolves.toBeUndefined();
  });

  test('a file encrypted with another key does not load and is logged without its contents', async () => {
    await persistStorageState({
      profileDir: tmpDir,
      userId: 'user-2',
      context: contextReturning(SAMPLE_STATE),
      logger: { warn: jest.fn() },
      storageKey: KEY,
    });
    const warn = jest.fn();
    await expect(loadPersistedStorageState(tmpDir, 'user-2', { warn }, OTHER_KEY)).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(warn.mock.calls)).not.toContain('SECRET');
  });

  test('a tampered file does not load', async () => {
    const result = await persistStorageState({
      profileDir: tmpDir,
      userId: 'user-3',
      context: contextReturning(SAMPLE_STATE),
      logger: { warn: jest.fn() },
      storageKey: KEY,
    });
    const bytes = await fs.readFile(result.storageStatePath);
    bytes[bytes.length - 1] ^= 0x01;
    await fs.writeFile(result.storageStatePath, bytes);

    await expect(loadPersistedStorageState(tmpDir, 'user-3', { warn: jest.fn() }, KEY)).resolves.toBeUndefined();
  });

  test('a legacy plaintext file is ignored, not loaded', async () => {
    const { storageStatePath } = getUserPersistencePaths(tmpDir, 'user-4');
    await fs.mkdir(path.dirname(storageStatePath), { recursive: true });
    await fs.writeFile(storageStatePath, JSON.stringify(SAMPLE_STATE));

    await expect(loadPersistedStorageState(tmpDir, 'user-4', { warn: jest.fn() }, KEY)).resolves.toBeUndefined();
  });

  test('a failed persist leaves the previous state intact and cleans up tmp files', async () => {
    const originalState = {
      cookies: [{ name: 'orig', value: 'v1', domain: '.example.com', path: '/' }],
    };
    const first = await persistStorageState({
      profileDir: tmpDir,
      userId: 'user-5',
      context: contextReturning(originalState),
      logger: { warn: jest.fn() },
      storageKey: KEY,
    });
    expect(first.persisted).toBe(true);

    const failingContext = {
      storageState: jest.fn(async () => {
        throw new Error('simulated crash mid-write');
      }),
    };
    const second = await persistStorageState({
      profileDir: tmpDir,
      userId: 'user-5',
      context: failingContext,
      logger: { warn: jest.fn() },
      storageKey: KEY,
    });
    expect(second.persisted).toBe(false);

    const { userDir } = getUserPersistencePaths(tmpDir, 'user-5');
    await expect(loadPersistedStorageState(tmpDir, 'user-5', undefined, KEY)).resolves.toEqual(originalState);

    const leftovers = (await fs.readdir(userDir)).filter((name) => name.includes('.tmp-'));
    expect(leftovers).toEqual([]);
  });
});

describe('parseStorageKey', () => {
  test('accepts 32 random bytes, base64 encoded', () => {
    const encoded = crypto.randomBytes(32).toString('base64');
    expect(parseStorageKey(encoded).length).toBe(32);
  });

  test('returns null when no key is set', () => {
    expect(parseStorageKey('')).toBeNull();
    expect(parseStorageKey(undefined)).toBeNull();
  });

  test('rejects keys that are not 32 bytes', () => {
    expect(() => parseStorageKey(crypto.randomBytes(16).toString('base64'))).toThrow(/32 random bytes/);
  });
});
