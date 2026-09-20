import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { jest } from '@jest/globals';

// Mock the launcher module -- index.js no longer imports child_process directly
const mockWatcher = () => {
  const proc = new EventEmitter();
  proc.pid = 12345;
  proc.exitCode = null;
  proc.kill = jest.fn();
  return proc;
};
const mockStartWatcher = jest.fn(mockWatcher);
const mockStopWatcher = jest.fn((watcher) => {
  if (watcher) watcher.exitCode = 0;
  return true;
});
const resolvedConfig = (pluginConfig = {}) => ({
  enabled: (pluginConfig.transportEnabled ?? pluginConfig.enabled) || false,
  autoStart: pluginConfig.autoStart || false,
  enableNoVnc: pluginConfig.enableNoVnc || false,
  resolution: pluginConfig.resolution
    ? (pluginConfig.resolution.split('x').length > 2 ? pluginConfig.resolution : `${pluginConfig.resolution}x24`)
    : '1920x1080x24',
  vncPassword: pluginConfig.password || '',
  viewOnly: pluginConfig.viewOnly || false,
  vncPort: pluginConfig.vncPort || '5900',
  novncPort: pluginConfig.novncPort || '6080',
  idleTimeoutMs: pluginConfig.idleTimeoutMs ?? 0,
});
const mockResolveVncConfig = jest.fn(resolvedConfig);

jest.unstable_mockModule('./vnc-launcher.js', () => ({
  resolveVncConfig: mockResolveVncConfig,
  startWatcher: mockStartWatcher,
  stopWatcher: mockStopWatcher,
}));

// Mock auth middleware
jest.unstable_mockModule('../../lib/auth.js', () => ({
  requireAuth: () => (_req, _res, next) => next(),
}));

// Minimal VirtualDisplay mock (real class has side-effects that break in test)
class MockVirtualDisplay {
  get xvfb_args() {
    return ['-screen', '0', '1x1x24', '-ac', '-nolisten', 'tcp'];
  }
}

const { register } = await import('./index.js');

describe('vnc plugin', () => {
  let events, ctx, mockApp, routes;

  beforeEach(() => {
    events = new EventEmitter();
    events.setMaxListeners(50);
    // The real plugin uses emitAsync for storage export; tests emulate it.
    events.emitAsync = async function emitAsync(eventName, payload) {
      await Promise.all(this.listeners(eventName).map((fn) => fn(payload)));
    };
    routes = {};
    mockApp = {
      get: jest.fn((path, ...handlers) => { routes[`GET ${path}`] = handlers; }),
      post: jest.fn((path, ...handlers) => { routes[`POST ${path}`] = handlers; }),
    };
    ctx = {
      events,
      config: {},
      log: jest.fn(),
      sessions: new Map(),
      safeError: (err) => typeof err === 'string' ? err : (err?.message || 'Internal error'),
      ensureBrowser: jest.fn(async () => ({})),
      acquireBrowserIdleHold: jest.fn(),
      releaseBrowserIdleHold: jest.fn(),
      VirtualDisplay: MockVirtualDisplay,
      createVirtualDisplay: () => new MockVirtualDisplay(),
    };
    mockStartWatcher.mockClear();
    mockStartWatcher.mockImplementation(mockWatcher);
    mockStopWatcher.mockClear();
    mockStopWatcher.mockImplementation((watcher) => {
      if (watcher) watcher.exitCode = 0;
      return true;
    });
    mockResolveVncConfig.mockClear();
    mockResolveVncConfig.mockImplementation(resolvedConfig);
  });

  test('does not register when disabled', async () => {
    await register(mockApp, ctx, {});
    expect(mockStartWatcher).not.toHaveBeenCalled();
    expect(mockApp.get).not.toHaveBeenCalled();
    expect(mockApp.post).not.toHaveBeenCalled();
  });

  test('registers routes when pluginConfig.enabled is true without autostarting watcher', async () => {
    await register(mockApp, ctx, { enabled: true });
    expect(mockStartWatcher).not.toHaveBeenCalled();
    expect(mockApp.get).toHaveBeenCalledWith('/vnc/status', expect.any(Function), expect.any(Function));
    expect(mockApp.post).toHaveBeenCalledWith('/vnc/start', expect.any(Function), expect.any(Function));
    expect(mockApp.post).toHaveBeenCalledWith('/vnc/stop', expect.any(Function), expect.any(Function));
    expect(mockApp.get).toHaveBeenCalledWith(
      '/sessions/:userId/storage_state',
      expect.any(Function),
      expect.any(Function),
    );
  });

  test('can override Xvfb resolution while transport routes remain disabled', async () => {
    await register(mockApp, ctx, {
      enabled: true,
      transportEnabled: false,
      overrideDisplay: true,
      resolution: '1920x1080',
    });

    const vd = ctx.createVirtualDisplay();
    const args = vd.xvfb_args;
    const screenIdx = args.indexOf('0');
    expect(args[screenIdx + 1]).toBe('1920x1080x24');
    expect(mockStartWatcher).not.toHaveBeenCalled();
    expect(mockApp.get).not.toHaveBeenCalled();
    expect(mockApp.post).not.toHaveBeenCalled();
  });

  test('starts watcher on /vnc/start with the owning display', async () => {
    await register(mockApp, ctx, { enabled: true, password: 'secret', vncPort: 5901 });
    events.emit('browser:launched', { display: ':261', displayPid: 2261 });
    const handler = routes['POST /vnc/start'].at(-1);
    const res = { status: jest.fn().mockReturnThis(), json: jest.fn() };
    await handler({ headers: { host: 'localhost:9377' } }, res);

    expect(mockStartWatcher).toHaveBeenCalledWith(
      expect.objectContaining({
        display: ':261',
        displayPid: 2261,
        vncPassword: 'secret',
        vncPort: 5901,
        log: ctx.log,
        events,
      }),
    );
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ ok: true, running: true, pid: 12345 }));
    expect(ctx.acquireBrowserIdleHold).toHaveBeenCalledWith('vnc-user-access');
  });

  test('refuses to start before the owning display is known', async () => {
    await register(mockApp, ctx, { enabled: true });
    const handler = routes['POST /vnc/start'].at(-1);
    const res = { status: jest.fn().mockReturnThis(), json: jest.fn() };
    await handler({ headers: { host: 'localhost:9377' } }, res);
    expect(mockStartWatcher).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(409);
  });

  test('autostarts watcher after browser:launched provides the display', async () => {
    await register(mockApp, ctx, { enabled: true, autoStart: true });
    expect(mockStartWatcher).not.toHaveBeenCalled();
    events.emit('browser:launched', { display: ':261', displayPid: 2261 });
    expect(mockStartWatcher).toHaveBeenCalledTimes(1);
    expect(mockStartWatcher).toHaveBeenCalledWith(expect.objectContaining({ display: ':261' }));
  });

  test('reattaches requested access after the real browser close and relaunch sequence', async () => {
    await register(mockApp, ctx, { enabled: true, autoStart: true });
    events.emit('browser:launched', { display: ':261', displayPid: 2261 });
    const firstWatcher = mockStartWatcher.mock.results[0].value;
    events.emit('browser:closing', { reason: 'restart' });
    expect(mockStopWatcher).toHaveBeenCalledWith(firstWatcher, ctx.log);
    firstWatcher.emit('exit', 0, 'SIGTERM');
    events.emit('browser:closed', { reason: 'restart' });
    expect(mockStartWatcher).toHaveBeenCalledTimes(1);
    events.emit('browser:launched', { display: ':262', displayPid: 2262 });
    expect(mockStartWatcher).toHaveBeenCalledTimes(2);
    expect(mockStartWatcher).toHaveBeenLastCalledWith(expect.objectContaining({ display: ':262', displayPid: 2262 }));
  });

  test('restores a time-bounded access request after a sidecar process restart', async () => {
    const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'camofox-vnc-lease-'));
    try {
      ctx.config = { profileDir };
      await register(mockApp, ctx, { enabled: true });
      events.emit('browser:launched', { display: ':261', displayPid: 2261 });
      const startHandler = routes['POST /vnc/start'].at(-1);
      const response = { status: jest.fn().mockReturnThis(), json: jest.fn() };
      await startHandler({ body: { leaseSeconds: 900 }, headers: { host: 'localhost:9377' } }, response);
      expect(fs.existsSync(path.join(profileDir, 'vnc-access-lease.json'))).toBe(true);
      await events.emitAsync('server:shutdown');

      const restartedEvents = new EventEmitter();
      restartedEvents.emitAsync = async function emitAsync(eventName, payload) {
        await Promise.all(this.listeners(eventName).map((fn) => fn(payload)));
      };
      const restartedApp = { get: jest.fn(), post: jest.fn() };
      const restartedCtx = {
        ...ctx,
        events: restartedEvents,
        acquireBrowserIdleHold: jest.fn(),
        releaseBrowserIdleHold: jest.fn(),
      };
      mockStartWatcher.mockClear();
      await register(restartedApp, restartedCtx, { enabled: true });
      restartedEvents.emit('browser:launched', { display: ':262', displayPid: 2262 });
      expect(mockStartWatcher).toHaveBeenCalledWith(expect.objectContaining({ display: ':262', displayPid: 2262 }));
      expect(restartedCtx.acquireBrowserIdleHold).toHaveBeenCalledWith('vnc-user-access');
    } finally {
      fs.rmSync(profileDir, { recursive: true, force: true });
    }
  });

  test('expires access even while the watcher is down during browser handoff', async () => {
    jest.useFakeTimers();
    const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'camofox-vnc-expiry-'));
    try {
      ctx.config = { profileDir };
      await register(mockApp, ctx, { enabled: true, idleTimeoutMs: 50 });
      events.emit('browser:launched', { display: ':261', displayPid: 2261 });
      const startHandler = routes['POST /vnc/start'].at(-1);
      await startHandler(
        { body: { leaseSeconds: 900 }, headers: { host: 'localhost:9377' } },
        { status: jest.fn().mockReturnThis(), json: jest.fn() },
      );
      events.emit('browser:closing');
      jest.advanceTimersByTime(60);
      expect(fs.existsSync(path.join(profileDir, 'vnc-access-lease.json'))).toBe(false);
      expect(ctx.releaseBrowserIdleHold).toHaveBeenCalledWith('vnc-user-access');
    } finally {
      jest.useRealTimers();
      fs.rmSync(profileDir, { recursive: true, force: true });
    }
  });

  test('bounds repeated watcher recovery failures and then fails closed', async () => {
    jest.useFakeTimers();
    const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'camofox-vnc-recovery-'));
    try {
      ctx.config = { profileDir };
      await register(mockApp, ctx, { enabled: true, idleTimeoutMs: 15 * 60_000 });
      events.emit('browser:launched', { display: ':261', displayPid: 2261 });
      const startHandler = routes['POST /vnc/start'].at(-1);
      await startHandler(
        { body: { leaseSeconds: 900 }, headers: { host: 'localhost:9377' } },
        { status: jest.fn().mockReturnThis(), json: jest.fn() },
      );

      for (let attempt = 0; attempt < 6; attempt += 1) {
        const child = mockStartWatcher.mock.results.at(-1).value;
        child.exitCode = 1;
        child.emit('exit', 1, null);
        jest.advanceTimersByTime(11_000);
      }

      expect(mockStartWatcher).toHaveBeenCalledTimes(6);
      expect(fs.existsSync(path.join(profileDir, 'vnc-access-lease.json'))).toBe(false);
      expect(ctx.releaseBrowserIdleHold).toHaveBeenCalledWith('vnc-user-access');
    } finally {
      jest.useRealTimers();
      fs.rmSync(profileDir, { recursive: true, force: true });
    }
  });

  test('overrides createVirtualDisplay with custom resolution', async () => {
    await register(mockApp, ctx, { enabled: true, resolution: '1280x720' });

    const vd = ctx.createVirtualDisplay();
    const args = vd.xvfb_args;
    const screenIdx = args.indexOf('0');
    expect(args[screenIdx + 1]).toBe('1280x720x24');
  });

  test('appends x24 depth to WxH resolution', async () => {
    await register(mockApp, ctx, { enabled: true, resolution: '1920x1080' });

    const vd = ctx.createVirtualDisplay();
    const args = vd.xvfb_args;
    const screenIdx = args.indexOf('0');
    expect(args[screenIdx + 1]).toBe('1920x1080x24');
  });

  test('preserves explicit depth in resolution', async () => {
    await register(mockApp, ctx, { enabled: true, resolution: '1920x1080x32' });

    const vd = ctx.createVirtualDisplay();
    const args = vd.xvfb_args;
    const screenIdx = args.indexOf('0');
    expect(args[screenIdx + 1]).toBe('1920x1080x32');
  });

  test('storage_state endpoint returns 404 for unknown user', async () => {
    await register(mockApp, ctx, { enabled: true });

    const handler = routes['GET /sessions/:userId/storage_state'].at(-1);
    const req = { params: { userId: 'unknown' }, reqId: 'test' };
    const res = { status: jest.fn().mockReturnThis(), json: jest.fn() };

    await handler(req, res);
    expect(res.status).toHaveBeenCalledWith(404);
  });

  test('storage_state endpoint rejects native persistent contexts without protocol export', async () => {
    ctx.config.persistentContext = true;
    await register(mockApp, ctx, { enabled: true });
    const storageState = jest.fn(async () => ({ cookies: [], origins: [] }));
    ctx.sessions.set('user-1', { context: { _persistentLease: true, storageState } });

    const handler = routes['GET /sessions/:userId/storage_state'].at(-1);
    const req = { params: { userId: 'user-1' }, reqId: 'test' };
    const res = { status: jest.fn().mockReturnThis(), json: jest.fn() };

    await handler(req, res);
    expect(res.status).toHaveBeenCalledWith(409);
    expect(storageState).not.toHaveBeenCalled();
  });

  test('storage_state endpoint returns state for active session', async () => {
    await register(mockApp, ctx, { enabled: true });

    const mockState = { cookies: [{ name: 'sid', value: 'abc' }], origins: [] };
    ctx.sessions.set('user-1', {
      context: { storageState: jest.fn(async () => mockState) },
    });

    const handler = routes['GET /sessions/:userId/storage_state'].at(-1);
    const req = { params: { userId: 'user-1' }, reqId: 'test' };
    const res = { json: jest.fn() };

    await handler(req, res);
    expect(res.json).toHaveBeenCalledWith(mockState);
  });

  test('storage_state endpoint uses safeError on failure', async () => {
    await register(mockApp, ctx, { enabled: true });

    ctx.sessions.set('user-1', {
      context: { storageState: jest.fn(async () => { throw new Error('context destroyed'); }) },
    });

    const handler = routes['GET /sessions/:userId/storage_state'].at(-1);
    const req = { params: { userId: 'user-1' }, reqId: 'test' };
    const res = { status: jest.fn().mockReturnThis(), json: jest.fn() };

    await handler(req, res);
    expect(res.status).toHaveBeenCalledWith(500);
    // safeError returns the message string -- not the raw Error object
    expect(res.json).toHaveBeenCalledWith({ error: 'context destroyed' });
  });

  test('emits vnc:storage:exported and session:storage:export on export', async () => {
    await register(mockApp, ctx, { enabled: true });

    ctx.sessions.set('user-1', {
      context: { storageState: jest.fn(async () => ({ cookies: [], origins: [] })) },
    });

    const exported = [];
    events.on('vnc:storage:exported', (e) => exported.push(e));
    events.on('session:storage:export', (e) => exported.push(e));

    const handler = routes['GET /sessions/:userId/storage_state'].at(-1);
    await handler(
      { params: { userId: 'user-1' }, reqId: 'test' },
      { json: jest.fn() },
    );

    expect(exported).toHaveLength(2);
    expect(exported[0]).toMatchObject({ userId: 'user-1' });
  });

  test('watcher is stopped on server:shutdown only if it was started', async () => {
    await register(mockApp, ctx, { enabled: true });
    expect(mockStartWatcher).not.toHaveBeenCalled();

    const startHandler = routes['POST /vnc/start'].at(-1);
    events.emit('browser:launched', { display: ':261', displayPid: 2261 });
    await startHandler({ headers: { host: 'localhost:9377' } }, { status: jest.fn().mockReturnThis(), json: jest.fn() });

    await events.emitAsync('server:shutdown');
    expect(mockStopWatcher).toHaveBeenCalledWith(expect.objectContaining({ pid: 12345 }), ctx.log);
  });
});
