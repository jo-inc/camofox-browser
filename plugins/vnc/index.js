/**
 * VNC plugin for camofox-browser.
 *
 * Exposes Camoufox's virtual display via noVNC so a human can interact with
 * the browser visually -- log into sites, solve CAPTCHAs, approve OAuth prompts.
 * After interactive login, export the storage state via the API endpoint this
 * plugin registers.
 *
 * Architecture:
 *   Plugin replaces the default 1x1 Xvfb with a 1920x1080 display (via
 *   ctx.createVirtualDisplay factory override). vnc-watcher.sh detects the
 *   Xvfb process, attaches x11vnc, and noVNC (websockify) proxies it to a
 *   web UI on port 6080.
 *
 * Configuration (camofox.config.json):
 *   {
 *     "plugins": {
 *       "vnc": {
 *         "enabled": true,
 *         "resolution": "1920x1080",
 *         "password": "",
 *         "viewOnly": false,
 *         "vncPort": 5900,
 *         "novncPort": 6080
 *       }
 *     }
 *   }
 *
 * Or via environment variables (override config):
 *   ENABLE_VNC=1           Enable the plugin
 *   VNC_RESOLUTION=1920x1080
 *   VNC_PASSWORD=secret    Optional password for x11vnc
 *   VIEW_ONLY=1            View-only mode (no mouse/keyboard input)
 *   VNC_PORT=5900          x11vnc listen port
 *   NOVNC_PORT=6080        noVNC web UI port
 *
 * Registers:
 *   GET /vnc/status -- report watcher state and configured ports
 *   GET /sessions/:userId/storage_state -- export Playwright storageState as JSON
 *
 * Events emitted:
 *   vnc:watcher:started    { pid }
 *   vnc:watcher:stopped    { code, signal }
 *   vnc:storage:exported   { userId, cookies, origins }
 */

import { resolveVncConfig, startWatcher } from './vnc-launcher.js';
import { requireAuth } from '../../lib/auth.js';

export async function register(app, ctx, pluginConfig = {}) {
  const { events, config, log, sessions, VirtualDisplay, safeError } = ctx;

  // Resolve all config (env vars + pluginConfig) via the launcher module
  const vncConfig = resolveVncConfig(pluginConfig);

  if (!vncConfig.enabled) {
    log('info', 'vnc plugin: disabled (set ENABLE_VNC=1 or plugins.vnc.enabled=true)');
    return;
  }

  // --- Override Xvfb resolution ---
  const { resolution } = vncConfig;

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
  log('info', 'vnc plugin: overriding Xvfb resolution', { resolution });

  // --- VNC watcher process ---
  log('info', 'vnc plugin enabled', {
    resolution,
    novncPort: vncConfig.novncPort,
    vncPort: vncConfig.vncPort,
    viewOnly: vncConfig.viewOnly,
    passwordProtected: !!vncConfig.vncPassword,
  });

  const watcher = startWatcher({
    resolution: vncConfig.resolution,
    vncPassword: vncConfig.vncPassword,
    viewOnly: vncConfig.viewOnly,
    vncPort: vncConfig.vncPort,
    novncPort: vncConfig.novncPort,
    log,
    events,
  });

  // Clean up watcher on server shutdown
  events.on('server:shutdown', () => {
    if (watcher.exitCode === null) {
      log('info', 'killing vnc watcher on shutdown');
      watcher.kill('SIGTERM');
    }
  });

  // --- HTTP endpoint: GET /vnc/status ---
  app.get('/vnc/status', (_req, res) => {
    const watcherRunning = watcher.exitCode === null && !watcher.killed;
    const vncStatus = watcher.getVncStatus();
    res.json({
      enabled: true,
      running: watcherRunning && vncStatus.running,
      watcherRunning,
      ...(vncStatus.display ? { display: vncStatus.display } : {}),
      vncPort: Number(vncConfig.vncPort),
      novncPort: Number(vncConfig.novncPort),
      path: '/vnc.html',
    });
  });

  // --- HTTP endpoint: GET /sessions/:userId/storage_state ---
  const authMiddleware = requireAuth(config);

  app.get('/sessions/:userId/storage_state', authMiddleware, async (req, res) => {
    try {
      const userId = req.params.userId;
      const session = sessions.get(String(userId));
      if (!session) {
        return res.status(404).json({ error: `No active session for userId="${userId}"` });
      }

      const state = await session.context.storageState(ctx.persistenceStorageStateOptions);

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

      await events.emitAsync('session:storage:export', {
        userId: String(userId),
        storageState: state,
      });

      res.json(state);
    } catch (err) {
      log('error', 'storage_state export failed', { reqId: req.reqId, error: err.message });
      res.status(500).json({ error: safeError(err) });
    }
  });

  log('info', 'vnc plugin: registered VNC endpoints');
}
