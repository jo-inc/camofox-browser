/**
 * VNC plugin for camofox-browser.
 *
 * Exposes Camoufox's virtual display via noVNC so a human can interact with
 * the browser visually -- log into sites, solve CAPTCHAs, approve OAuth prompts.
 * The plugin now starts noVNC/x11vnc lazily via POST /vnc/start so normal agent
 * browsing does not keep VNC processes running.
 */

import fs from 'node:fs';
import path from 'node:path';
import { resolveVncConfig, startWatcher, stopWatcher } from './vnc-launcher.js';
import { requireAuth } from '../../lib/auth.js';

export async function register(app, ctx, pluginConfig = {}) {
  const { events, config, log, sessions, VirtualDisplay, safeError } = ctx;

  // Resolve all config (env vars + pluginConfig) via the launcher module.
  const vncConfig = resolveVncConfig(pluginConfig);

  // --- Override Xvfb resolution independently of transport ownership ---
  // The external takeover controller owns x11vnc/Guacamole on this machine,
  // but Camoufox's upstream VirtualDisplay still defaults to a 1x1 root.
  const { resolution } = vncConfig;
  const overrideDisplay = vncConfig.enabled || pluginConfig.overrideDisplay === true;

  if (overrideDisplay) {
    class VncVirtualDisplay extends VirtualDisplay {
      get xvfb_args() {
        const args = super.xvfb_args;
        const idx = args.indexOf('0');
        if (idx > 0 && args[idx - 1] === '-screen') {
          const patched = [...args];
          patched[idx + 1] = resolution;
          return patched;
        }
        return args;
      }
    }

    ctx.createVirtualDisplay = () => new VncVirtualDisplay();
    log('info', 'vnc plugin: overriding Xvfb resolution', { resolution, transportEnabled: vncConfig.enabled });
  }

  if (!vncConfig.enabled) {
    log('info', 'vnc transport disabled', { displayOverride: overrideDisplay });
    return;
  }

  // --- Lazy VNC watcher process ---
  let watcher = null;
  let idleTimer = null;
  let startedAt = null;
  let activeDisplay = '';
  let activeDisplayPid = null;
  const accessLeasePath = config.profileDir ? path.join(config.profileDir, 'vnc-access-lease.json') : '';
  const restoredLease = readAccessLease();
  let accessRequested = !!restoredLease;
  let accessExpiresAt = restoredLease?.expiresAt || 0;
  let recoveryAttempts = 0;
  let recoveryTimer = null;
  let recoveryStableTimer = null;
  let expectedWatcherExit = false;
  let restartAfterExpectedExit = false;
  const idleHoldKey = 'vnc-user-access';

  function readAccessLease() {
    if (!accessLeasePath) return null;
    try {
      const payload = JSON.parse(fs.readFileSync(accessLeasePath, 'utf8'));
      const expiresAt = Number(payload?.expiresAt);
      if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) {
        fs.rmSync(accessLeasePath, { force: true });
        return null;
      }
      return { expiresAt };
    } catch {
      return null;
    }
  }

  function writeAccessLease() {
    if (!accessLeasePath || !accessExpiresAt) return;
    const temporary = `${accessLeasePath}.tmp`;
    fs.mkdirSync(path.dirname(accessLeasePath), { recursive: true, mode: 0o700 });
    fs.writeFileSync(temporary, `${JSON.stringify({ expiresAt: accessExpiresAt })}\n`, { mode: 0o600 });
    fs.renameSync(temporary, accessLeasePath);
  }

  function clearAccessLease() {
    if (accessLeasePath) fs.rmSync(accessLeasePath, { force: true });
    accessExpiresAt = 0;
  }

  events.on('browser:launched', ({ display, displayPid } = {}) => {
    const nextDisplay = display || '';
    const nextDisplayPid = Number(displayPid) || null;
    if (!nextDisplay || !nextDisplayPid) {
      log('warn', 'vnc plugin: browser launched without an owning display identity');
      return;
    }
    const changed = !!activeDisplay && (activeDisplay !== nextDisplay || activeDisplayPid !== nextDisplayPid);
    activeDisplay = nextDisplay;
    activeDisplayPid = nextDisplayPid;
    if (watcher && watcher.exitCode === null && changed) {
      stopTransport('browser_display_changed', { restart: true });
    } else if ((accessRequested || vncConfig.autoStart) && (!watcher || watcher.exitCode !== null)) {
      try {
        start(vncConfig.autoStart && !accessRequested ? 'autostart' : 'browser_relaunched');
      } catch (error) {
        log('error', 'vnc plugin: failed to attach after browser launch', { error: safeError(error) });
      }
    }
  });

  events.on('browser:closing', () => {
    activeDisplay = '';
    activeDisplayPid = null;
    stopTransport('browser_closing');
  });

  events.on('browser:closed', () => {
    activeDisplay = '';
    activeDisplayPid = null;
  });

  function vncUrl(req) {
    const host = req?.headers?.host?.replace(/:.*/, '') || '127.0.0.1';
    return `http://${host}:${vncConfig.novncPort}/vnc.html?host=${host}&port=${vncConfig.novncPort}`;
  }

  function status(req) {
    const running = !!watcher && watcher.exitCode === null;
    return {
      enabled: true,
      running,
      requested: accessRequested,
      expiresAt: accessExpiresAt ? new Date(accessExpiresAt).toISOString() : null,
      pid: running ? watcher.pid : null,
      startedAt,
      autoStart: vncConfig.autoStart,
      idleTimeoutMs: vncConfig.idleTimeoutMs,
      resolution: vncConfig.resolution,
      vncPort: vncConfig.vncPort,
      novncPort: vncConfig.novncPort,
      viewOnly: vncConfig.viewOnly,
      passwordProtected: !!vncConfig.vncPassword,
      url: running && vncConfig.enableNoVnc ? vncUrl(req) : null,
    };
  }

  function clearIdleTimer() {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = null;
  }

  function clearRecoveryTimers() {
    if (recoveryTimer) clearTimeout(recoveryTimer);
    if (recoveryStableTimer) clearTimeout(recoveryStableTimer);
    recoveryTimer = null;
    recoveryStableTimer = null;
  }

  function hasValidAccessLease() {
    return accessRequested && Number.isFinite(accessExpiresAt) && accessExpiresAt > Date.now();
  }

  function scheduleRecovery(reason) {
    if (!hasValidAccessLease() || !activeDisplay || !activeDisplayPid) {
      if (accessRequested && accessExpiresAt <= Date.now()) stop('access_lease_expired');
      return;
    }
    if (recoveryTimer) return;
    if (recoveryAttempts >= 5) {
      log('error', 'vnc plugin: recovery limit reached; failing closed', { reason, attempts: recoveryAttempts });
      stop('watcher_recovery_exhausted');
      return;
    }
    const delayMs = Math.min(1_000 * (2 ** recoveryAttempts), 10_000);
    recoveryAttempts += 1;
    recoveryTimer = setTimeout(() => {
      recoveryTimer = null;
      if (!hasValidAccessLease() || !activeDisplay || !activeDisplayPid) {
        if (accessRequested && accessExpiresAt <= Date.now()) stop('access_lease_expired');
        return;
      }
      try {
        start('watcher_recovery');
      } catch (error) {
        log('error', 'vnc plugin: watcher recovery failed', { error: safeError(error), attempt: recoveryAttempts });
        scheduleRecovery('watcher_start_failed');
      }
    }, delayMs);
    recoveryTimer.unref?.();
  }

  function scheduleIdleStop() {
    clearIdleTimer();
    const remainingLeaseMs = accessExpiresAt ? accessExpiresAt - Date.now() : Number.POSITIVE_INFINITY;
    const configuredIdleMs = vncConfig.idleTimeoutMs > 0 ? vncConfig.idleTimeoutMs : Number.POSITIVE_INFINITY;
    const timeoutMs = Math.min(remainingLeaseMs, configuredIdleMs);
    if (!Number.isFinite(timeoutMs)) return;
    if (timeoutMs <= 0) {
      stop('access_lease_expired');
      return;
    }
    idleTimer = setTimeout(() => {
      if (accessRequested) {
        log('info', 'vnc access timeout reached; stopping access', { timeoutMs });
        stop('access_timeout');
      }
    }, timeoutMs);
    idleTimer.unref?.();
  }

  function start(reason = 'manual', { expiresAt } = {}) {
    if (!activeDisplay || !activeDisplayPid) {
      throw Object.assign(new Error('Camofox browser display is not ready'), { statusCode: 409 });
    }
    const requestedExpiry = Number(expiresAt);
    const hasExplicitExpiry = Number.isFinite(requestedExpiry) && requestedExpiry > Date.now();
    if (expiresAt !== undefined && !hasExplicitExpiry) {
      throw Object.assign(new Error('VNC access lease is already expired'), { statusCode: 410 });
    }
    if (hasExplicitExpiry) {
      accessExpiresAt = requestedExpiry;
      recoveryAttempts = 0;
      clearRecoveryTimers();
    } else if (reason === 'autostart' && !accessExpiresAt) {
      const defaultLeaseMs = vncConfig.idleTimeoutMs > 0 ? vncConfig.idleTimeoutMs : 15 * 60_000;
      accessExpiresAt = Date.now() + defaultLeaseMs;
    }
    if (!Number.isFinite(accessExpiresAt) || accessExpiresAt <= Date.now()) {
      stop('access_lease_expired');
      throw Object.assign(new Error('VNC access lease expired'), { statusCode: 410 });
    }
    accessRequested = true;
    writeAccessLease();
    ctx.acquireBrowserIdleHold?.(idleHoldKey);
    if (watcher && watcher.exitCode === null) {
      scheduleIdleStop();
      return watcher;
    }

    log('info', 'starting vnc watcher', {
      reason,
      resolution,
      display: activeDisplay,
      displayPid: activeDisplayPid,
      novncPort: vncConfig.novncPort,
      vncPort: vncConfig.vncPort,
      viewOnly: vncConfig.viewOnly,
      passwordProtected: !!vncConfig.vncPassword,
    });

    try {
      watcher = startWatcher({
        resolution: vncConfig.resolution,
        display: activeDisplay,
        displayPid: activeDisplayPid,
        enableNoVnc: vncConfig.enableNoVnc,
        vncPassword: vncConfig.vncPassword,
        viewOnly: vncConfig.viewOnly,
        vncPort: vncConfig.vncPort,
        novncPort: vncConfig.novncPort,
        log,
        events,
      });
    } catch (error) {
      accessRequested = false;
      clearAccessLease();
      ctx.releaseBrowserIdleHold?.(idleHoldKey);
      throw error;
    }
    startedAt = new Date().toISOString();
    if (recoveryStableTimer) clearTimeout(recoveryStableTimer);
    recoveryStableTimer = setTimeout(() => {
      recoveryStableTimer = null;
      recoveryAttempts = 0;
    }, 30_000);
    recoveryStableTimer.unref?.();
    watcher.once('exit', () => {
      const exitedExpectedly = expectedWatcherExit;
      const shouldRestartAfterExit = restartAfterExpectedExit;
      expectedWatcherExit = false;
      restartAfterExpectedExit = false;
      watcher = null;
      startedAt = null;
      if (recoveryStableTimer) clearTimeout(recoveryStableTimer);
      recoveryStableTimer = null;
      if (!hasValidAccessLease()) {
        if (accessRequested) stop('access_lease_expired');
        return;
      }
      if (!exitedExpectedly || shouldRestartAfterExit) {
        scheduleRecovery(exitedExpectedly ? 'display_changed' : 'watcher_exited');
      }
    });
    scheduleIdleStop();
    return watcher;
  }

  function stopTransport(reason, { restart = false } = {}) {
    if (!watcher || watcher.exitCode !== null) {
      if (restart) scheduleRecovery(reason);
      return false;
    }
    expectedWatcherExit = true;
    restartAfterExpectedExit = restart;
    log('info', 'stopping vnc watcher', { reason, pid: watcher.pid, restart });
    return stopWatcher(watcher, log);
  }

  function stop(reason = 'manual') {
    accessRequested = false;
    clearIdleTimer();
    clearRecoveryTimers();
    recoveryAttempts = 0;
    clearAccessLease();
    ctx.releaseBrowserIdleHold?.(idleHoldKey);
    return stopTransport(reason);
  }

  log('info', 'vnc plugin enabled (lazy)', {
    resolution,
    novncPort: vncConfig.novncPort,
    vncPort: vncConfig.vncPort,
    autoStart: vncConfig.autoStart,
    idleTimeoutMs: vncConfig.idleTimeoutMs,
    viewOnly: vncConfig.viewOnly,
    passwordProtected: !!vncConfig.vncPassword,
  });

  const authMiddleware = requireAuth(config);

  // --- HTTP endpoints: lazy VNC control ---
  app.get('/vnc/status', authMiddleware, async (req, res) => {
    res.json(status(req));
  });

  app.post('/vnc/start', authMiddleware, async (req, res) => {
    try {
      const leaseSeconds = Number(req.body?.leaseSeconds ?? 15 * 60);
      if (!Number.isFinite(leaseSeconds) || leaseSeconds < 30 || leaseSeconds > 60 * 60) {
        return res.status(400).json({ ok: false, error: 'leaseSeconds must be between 30 and 3600' });
      }
      await ctx.ensureBrowser();
      start('api_start', { expiresAt: Date.now() + Math.floor(leaseSeconds * 1000) });
      res.json({ ok: true, ...status(req) });
    } catch (error) {
      res.status(Number(error?.statusCode) || 500).json({ ok: false, error: safeError(error), ...status(req) });
    }
  });

  app.post('/vnc/stop', authMiddleware, async (req, res) => {
    const stopped = stop('api_stop');
    res.json({ ok: true, stopped, ...status(req) });
  });

  // Autostart is deferred until browser:launched provides the owning display.

  // Clean up watcher on server shutdown.
  events.on('server:shutdown', async () => {
    ctx.releaseBrowserIdleHold?.(idleHoldKey);
    stopTransport('server_shutdown');
  });

  // --- HTTP endpoint: GET /sessions/:userId/storage_state ---
  app.get('/sessions/:userId/storage_state', authMiddleware, async (req, res) => {
    try {
      const userId = req.params.userId;
      const session = sessions.get(String(userId));
      if (!session) {
        return res.status(404).json({ error: `No active session for userId="${userId}"` });
      }
      if (config.persistentContext || session.context?._persistentLease) {
        return res.status(409).json({
          error: 'storage_state export is unavailable for native persistent profiles; browser state is stored in userDataDir',
        });
      }

      const state = await session.context.storageState();

      log('info', 'storage_state exported', {
        reqId: req.reqId,
        userId: String(userId),
        cookies: state.cookies?.length || 0,
        origins: state.origins?.length || 0,
      });

      events.emit('vnc:storage:exported', {
        userId: String(userId),
        cookies: state.cookies?.length || 0,
        origins: state.origins?.length || 0,
      });

      await events.emitAsync('session:storage:export', { userId: String(userId) });

      res.json(state);
    } catch (err) {
      log('error', 'storage_state export failed', { reqId: req.reqId, error: err.message });
      res.status(500).json({ error: safeError(err) });
    }
  });

  log('info', 'vnc plugin: registered lazy VNC and storage_state endpoints');
}
