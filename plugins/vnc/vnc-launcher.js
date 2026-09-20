/**
 * VNC launcher -- owns all process spawning and env reads.
 * Isolated from route handlers to keep subprocess management separate.
 */

import { spawn } from './spawn.js';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Resolve VNC configuration from pluginConfig + env var fallbacks.
 * All process.env reads live here -- callers get a plain config object.
 */
export function resolveVncConfig(pluginConfig = {}) {
  const hasPluginConfig = pluginConfig && Object.keys(pluginConfig).length > 0;
  const configuredTransport = pluginConfig.transportEnabled ?? pluginConfig.enabled;
  const enabled = process.env.ENABLE_VNC === '1'
    || configuredTransport === true
    || (hasPluginConfig && configuredTransport !== false);

  const autoStart = process.env.VNC_AUTOSTART === '1'
    || pluginConfig.autoStart === true
    || pluginConfig.autostart === true;
  const enableNoVnc = process.env.ENABLE_NOVNC === '1' || pluginConfig.enableNoVnc === true;

  const rawResolution = process.env.VNC_RESOLUTION || pluginConfig.resolution || '1920x1080';
  const resolution = rawResolution.includes('x', rawResolution.indexOf('x') + 1)
    ? rawResolution
    : `${rawResolution}x24`;

  const vncPassword = process.env.VNC_PASSWORD || pluginConfig.password || '';
  const viewOnly = process.env.VIEW_ONLY === '1' || pluginConfig.viewOnly === true;
  const vncPort = process.env.VNC_PORT || pluginConfig.vncPort || '5900';
  const novncPort = process.env.NOVNC_PORT || pluginConfig.novncPort || '6080';
  const idleTimeoutMs = Number(process.env.VNC_IDLE_TIMEOUT_MS ?? pluginConfig.idleTimeoutMs ?? 15 * 60_000);

  return { enabled, autoStart, enableNoVnc, resolution, vncPassword, viewOnly, vncPort, novncPort, idleTimeoutMs };
}

/**
 * Start the vnc-watcher.sh child process.
 * Returns the spawned ChildProcess.
 */
export function startWatcher({ resolution, display, displayPid, enableNoVnc, vncPassword, viewOnly, vncPort, novncPort, log, events }) {
  const watcherPath = path.join(__dirname, 'vnc-watcher.sh');
  const watcher = spawn('sh', [watcherPath], {
    env: {
      ...process.env,
      VNC_PASSWORD: vncPassword,
      VNC_RESOLUTION: resolution,
      CAMOFOX_VNC_DISPLAY: display || '',
      CAMOFOX_VNC_DISPLAY_PID: String(displayPid || ''),
      ENABLE_NOVNC: enableNoVnc ? '1' : '0',
      VIEW_ONLY: viewOnly ? '1' : '0',
      VNC_PORT: String(vncPort),
      NOVNC_PORT: String(novncPort),
    },
    stdio: ['ignore', 'inherit', 'inherit'],
    // Detached creates a process group so stopWatcher can reliably stop the
    // watcher, websockify, and x11vnc children together.
    detached: true,
  });

  watcher.on('error', (err) => {
    log('error', 'vnc watcher failed to start', { error: err.message });
  });

  watcher.on('exit', (code, signal) => {
    log('warn', 'vnc watcher exited', { code, signal });
    events.emit('vnc:watcher:stopped', { code, signal });
  });

  log('info', 'vnc watcher started', { pid: watcher.pid });
  events.emit('vnc:watcher:started', { pid: watcher.pid });

  return watcher;
}

/** Stop the watcher process group if possible. */
export function stopWatcher(watcher, log) {
  if (!watcher || watcher.exitCode !== null) return false;
  try {
    process.kill(-watcher.pid, 'SIGTERM');
    log?.('info', 'sent SIGTERM to vnc watcher process group', { pid: watcher.pid });
    return true;
  } catch (err) {
    try {
      watcher.kill('SIGTERM');
      log?.('info', 'sent SIGTERM to vnc watcher process', { pid: watcher.pid });
      return true;
    } catch {
      log?.('warn', 'failed to stop vnc watcher', { pid: watcher.pid, error: err.message });
      return false;
    }
  }
}
