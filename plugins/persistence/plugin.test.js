import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { jest } from '@jest/globals';
import { createPluginEvents } from '../../lib/plugins.js';
import { register } from './index.js';

describe('persistence plugin', () => {
  let tmpDir, events, ctx, mockApp;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'camofox-persist-plugin-'));
    events = createPluginEvents();
    mockApp = {};
    ctx = {
      events,
      config: { cookiesDir: path.join(tmpDir, 'cookies') },
      log: jest.fn(),
    };
  });

  afterEach(async () => {
    if (tmpDir) await fs.rm(tmpDir, { recursive: true, force: true });
  });

  test('skips registration when no profileDir configured', async () => {
    await register(mockApp, ctx, {});
    expect(ctx.log).toHaveBeenCalledWith('warn', expect.stringContaining('no profileDir'));
  });

  test('restores persisted state on session:creating', async () => {
    await register(mockApp, ctx, { profileDir: tmpDir });

    // Simulate a prior persisted state
    const { getUserPersistencePaths } = await import('../../lib/persistence.js');
    const { userDir, storageStatePath } = getUserPersistencePaths(tmpDir, 'user-1');
    await fs.mkdir(userDir, { recursive: true });
    await fs.writeFile(storageStatePath, JSON.stringify({
      cookies: [{ name: 'sid', value: 'abc', domain: '.example.com', path: '/' }],
      origins: [],
    }));

    const contextOptions = { viewport: { width: 1280, height: 720 } };
    await events.emitAsync('session:creating', { userId: 'user-1', contextOptions });

    expect(contextOptions.storageState).toBe(storageStatePath);
  });

  test('checkpoints on session:cookies:import', async () => {
    await register(mockApp, ctx, { profileDir: tmpDir });

    const mockContext = {
      storageState: jest.fn(async ({ path: p }) => {
        await fs.writeFile(p, JSON.stringify({ cookies: [{ name: 'x', value: 'y', domain: '.test.com', path: '/' }] }));
      }),
    };

    // Simulate session created then cookie import
    await events.emitAsync('session:created', { userId: 'user-2', context: mockContext });
    await events.emitAsync('session:cookies:import', { userId: 'user-2' });

    expect(mockContext.storageState).toHaveBeenCalled();

    // Verify file was written
    const { getUserPersistencePaths } = await import('../../lib/persistence.js');
    const { storageStatePath } = getUserPersistencePaths(tmpDir, 'user-2');
    const saved = JSON.parse(await fs.readFile(storageStatePath, 'utf8'));
    expect(saved.cookies[0].name).toBe('x');
  });

  test('checkpoints on session:destroying', async () => {
    await register(mockApp, ctx, { profileDir: tmpDir });

    const mockContext = {
      storageState: jest.fn(async ({ path: p }) => {
        await fs.writeFile(p, JSON.stringify({ cookies: [], origins: [] }));
      }),
    };

    await events.emitAsync('session:created', { userId: 'user-3', context: mockContext });
    await events.emitAsync('session:destroying', { userId: 'user-3', reason: 'test' });

    expect(mockContext.storageState).toHaveBeenCalled();
  });

  test('serializes concurrent checkpoints for one user', async () => {
    await register(mockApp, ctx, { profileDir: tmpDir, checkpointTimeoutMs: 1_000 });
    let active = 0;
    let maxActive = 0;
    const context = {
      storageState: jest.fn(async ({ path: targetPath }) => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        await new Promise(resolve => setTimeout(resolve, 20));
        await fs.writeFile(targetPath, JSON.stringify({ cookies: [], origins: [] }));
        active -= 1;
      }),
    };
    await events.emitAsync('session:created', { userId: 'serialized-user', context });

    await Promise.all([
      events.emitAsync('session:cookies:import', { userId: 'serialized-user' }),
      events.emitAsync('session:storage:export', { userId: 'serialized-user' }),
    ]);

    expect(context.storageState).toHaveBeenCalledTimes(2);
    expect(maxActive).toBe(1);
  });

  test('session close always takes a final normal-context checkpoint', async () => {
    await register(mockApp, ctx, { profileDir: tmpDir });
    const context = {
      storageState: jest.fn(async ({ path: targetPath }) => {
        await fs.writeFile(targetPath, JSON.stringify({ cookies: [], origins: [] }));
      }),
    };
    await events.emitAsync('session:created', { userId: 'final-user', context });
    await events.emitAsync('session:cookies:import', { userId: 'final-user' });
    await events.emitAsync('session:destroying', { userId: 'final-user', reason: 'test' });
    expect(context.storageState).toHaveBeenCalledTimes(2);
  });

  test('authoritative session close waits after the checkpoint warning timeout', async () => {
    await register(mockApp, ctx, { profileDir: tmpDir, checkpointTimeoutMs: 5 });
    let finished = false;
    const context = {
      storageState: jest.fn(async ({ path: targetPath }) => {
        await new Promise(resolve => setTimeout(resolve, 30));
        await fs.writeFile(targetPath, JSON.stringify({ cookies: [], origins: [] }));
        finished = true;
      }),
    };
    await events.emitAsync('session:created', { userId: 'slow-final-user', context });
    const startedAt = Date.now();
    await events.emitAsync('session:destroying', { userId: 'slow-final-user', reason: 'test' });
    expect(finished).toBe(true);
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(25);
  });

  test('native profile imports bootstrap cookies once and records a durable marker', async () => {
    ctx.config.persistentContext = true;
    const cookiesDir = ctx.config.cookiesDir;
    await fs.mkdir(cookiesDir, { recursive: true });
    await fs.writeFile(
      path.join(cookiesDir, 'cookies.txt'),
      '.example.com\tTRUE\t/\tFALSE\t0\tsid\tabc\n'
    );
    await register(mockApp, ctx, { profileDir: tmpDir });
    const context = { addCookies: jest.fn(async () => {}) };

    await events.emitAsync('session:created', { userId: 'native-a', context });
    await events.emitAsync('session:created', { userId: 'native-b', context });

    expect(context.addCookies).toHaveBeenCalledTimes(1);
    await expect(fs.access(path.join(tmpDir, '.native-bootstrap-imported.json'))).resolves.toBeUndefined();
  });

  test('does not mount checkpoint routes without the shared auth factory', async () => {
    mockApp.post = jest.fn();
    await register(mockApp, ctx, { profileDir: tmpDir });
    expect(mockApp.post).not.toHaveBeenCalled();
  });

  test('instantiates the shared auth middleware factory for checkpoint routes', async () => {
    const middleware = jest.fn((_req, _res, next) => next());
    ctx.auth = jest.fn(() => middleware);
    mockApp.post = jest.fn();

    await register(mockApp, ctx, { profileDir: tmpDir });

    expect(ctx.auth).toHaveBeenCalledTimes(1);
    expect(mockApp.post).toHaveBeenCalledWith('/sessions/checkpoint_all', middleware, expect.any(Function));
    expect(mockApp.post).toHaveBeenCalledWith('/sessions/:userId/checkpoint', middleware, expect.any(Function));
  });

  test('preserves explicit zero checkpoint interval', async () => {
    await register(mockApp, ctx, { profileDir: tmpDir, checkpointIntervalMs: 0 });
    expect(events.listenerCount('session:created')).toBeGreaterThan(0);
    expect(events.listenerCount('server:shutdown')).toBeGreaterThan(0);
  });

  test('env var CAMOFOX_PROFILE_DIR overrides pluginConfig', async () => {
    const envDir = path.join(tmpDir, 'env-override');
    const orig = process.env.CAMOFOX_PROFILE_DIR;
    process.env.CAMOFOX_PROFILE_DIR = envDir;
    try {
      await register(mockApp, ctx, { profileDir: '/should/not/use' });
      expect(ctx.log).toHaveBeenCalledWith('info', 'persistence plugin enabled', expect.objectContaining({ profileDir: envDir }));
    } finally {
      if (orig === undefined) delete process.env.CAMOFOX_PROFILE_DIR;
      else process.env.CAMOFOX_PROFILE_DIR = orig;
    }
  });
});
