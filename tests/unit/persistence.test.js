import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { jest } from '@jest/globals';
import {
  getUserPersistencePaths,
  loadPersistedStorageState,
  persistStorageState,
} from '../../lib/persistence.js';

describe('profile persistence helpers', () => {
  let tmpDir;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'camofox-persistence-'));
  });

  afterEach(async () => {
    if (tmpDir) {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
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

  test('loadPersistedStorageState returns undefined when no state exists', async () => {
    await expect(loadPersistedStorageState(tmpDir, 'user-1')).resolves.toBeUndefined();
  });

  test('persistStorageState writes storage state and metadata, then load returns the storage path', async () => {
    const storageState = {
      cookies: [{ name: 'session', value: 'abc', domain: '.example.com', path: '/' }],
      origins: [{ origin: 'https://app.example.com', localStorage: [{ name: 'foo', value: 'bar' }] }],
    };

    const context = {
      storageState: jest.fn(async ({ path: targetPath }) => {
        await fs.writeFile(targetPath, JSON.stringify(storageState, null, 2));
      }),
    };

    const result = await persistStorageState({
      profileDir: tmpDir,
      userId: 'user-1',
      context,
      logger: { warn: jest.fn() },
    });

    expect(result.persisted).toBe(true);
    expect(context.storageState).toHaveBeenCalledTimes(1);

    const loadedPath = await loadPersistedStorageState(tmpDir, 'user-1');
    expect(loadedPath).toBe(result.storageStatePath);

    const meta = JSON.parse(await fs.readFile(result.metaPath, 'utf8'));
    expect(meta.userId).toBe('user-1');
    expect(meta.storageStatePath).toBe(result.storageStatePath);
  });

  test('loadPersistedStorageState ignores invalid JSON files', async () => {
    const { storageStatePath } = getUserPersistencePaths(tmpDir, 'user-2');
    await fs.mkdir(path.dirname(storageStatePath), { recursive: true });
    await fs.writeFile(storageStatePath, '{not-json');

    await expect(loadPersistedStorageState(tmpDir, 'user-2', { warn: jest.fn() })).resolves.toBeUndefined();
  });

  test('a failed persist leaves the previous storage-state intact and cleans up tmp files', async () => {
    const originalState = {
      cookies: [{ name: 'orig', value: 'v1', domain: '.example.com', path: '/' }],
    };
    const goodContext = {
      storageState: jest.fn(async ({ path: targetPath }) => {
        await fs.writeFile(targetPath, JSON.stringify(originalState, null, 2));
      }),
    };
    const first = await persistStorageState({
      profileDir: tmpDir,
      userId: 'user-3',
      context: goodContext,
      logger: { warn: jest.fn() },
    });
    expect(first.persisted).toBe(true);

    const failingContext = {
      storageState: jest.fn(async () => {
        throw new Error('simulated crash mid-write');
      }),
    };
    const second = await persistStorageState({
      profileDir: tmpDir,
      userId: 'user-3',
      context: failingContext,
      logger: { warn: jest.fn() },
    });
    expect(second.persisted).toBe(false);

    const { userDir, storageStatePath } = getUserPersistencePaths(tmpDir, 'user-3');
    const loaded = await loadPersistedStorageState(tmpDir, 'user-3');
    expect(loaded).toBe(storageStatePath);
    const parsed = JSON.parse(await fs.readFile(storageStatePath, 'utf8'));
    expect(parsed).toEqual(originalState);

    const leftovers = (await fs.readdir(userDir)).filter((name) => name.includes('.tmp-'));
    expect(leftovers).toEqual([]);
  });
});
