/**
 * VNC launcher -- owns all process spawning and env reads.
 * Isolated from route handlers to keep subprocess management separate.
 */

import { spawn } from './spawn.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function envFlagEnabled(value) {
  return ['1', 'true', 'yes', 'on'].includes(String(value || '').toLowerCase());
}

function compactEnv(env) {
  return Object.fromEntries(
    Object.entries(env)
      .filter(([, value]) => value !== undefined && value !== null)
      .map(([key, value]) => [key, String(value)])
  );
}

/**
 * Resolve VNC configuration from pluginConfig + env var fallbacks.
 * All process.env reads live here -- callers get a plain config object.
 */
export function resolveVncConfig(pluginConfig = {}, env = process.env) {
  const enabled = envFlagEnabled(env.ENABLE_VNC) || pluginConfig.enabled === true;

  const rawResolution = env.VNC_RESOLUTION || pluginConfig.resolution || '1920x1080';
  const resolution = rawResolution.includes('x', rawResolution.indexOf('x') + 1)
    ? rawResolution
    : `${rawResolution}x24`;

  const vncPassword = env.VNC_PASSWORD || pluginConfig.password || '';
  const viewOnly = envFlagEnabled(env.VIEW_ONLY) || pluginConfig.viewOnly === true;
  const vncPort = env.VNC_PORT || pluginConfig.vncPort || '5900';
  const novncPort = env.NOVNC_PORT || pluginConfig.novncPort || '6080';

  return { enabled, resolution, vncPassword, viewOnly, vncPort, novncPort };
}

export function buildWatcherEnv({ resolution, vncPassword, viewOnly, vncPort, novncPort, statusFile }, env = process.env) {
  return compactEnv({
    PATH: env.PATH,
    HOME: env.HOME,
    VNC_BIND: env.VNC_BIND,
    VNC_PASSWORD: vncPassword,
    VNC_RESOLUTION: resolution,
    VIEW_ONLY: viewOnly ? '1' : '0',
    VNC_PORT: vncPort,
    NOVNC_PORT: novncPort,
    VNC_STATUS_FILE: statusFile,
  });
}

/**
 * Start the vnc-watcher.sh child process.
 * Returns the spawned ChildProcess.
 */
export function startWatcher({ resolution, vncPassword, viewOnly, vncPort, novncPort, log, events }) {
  const watcherPath = path.join(__dirname, 'vnc-watcher.sh');
  const statusDir = fs.mkdtempSync(path.join(os.tmpdir(), 'camofox-vnc-'));
  const statusFile = path.join(statusDir, 'status');
  const watcher = spawn('sh', [watcherPath], {
    env: buildWatcherEnv({ resolution, vncPassword, viewOnly, vncPort, novncPort, statusFile }),
    stdio: ['ignore', 'inherit', 'inherit'],
    detached: false,
  });

  watcher.on('error', (err) => {
    log('error', 'vnc watcher failed to start', { error: err.message });
  });

  watcher.on('exit', (code, signal) => {
    fs.rmSync(statusDir, { recursive: true, force: true });
    log('warn', 'vnc watcher exited', { code, signal });
    events.emit('vnc:watcher:stopped', { code, signal });
  });

  watcher.getVncStatus = () => {
    try {
      const [display, pid] = fs.readFileSync(statusFile, 'utf8').trim().split(' ');
      return { running: true, display, pid: Number(pid) };
    } catch {
      return { running: false };
    }
  };

  log('info', 'vnc watcher started', { pid: watcher.pid });
  events.emit('vnc:watcher:started', { pid: watcher.pid });

  return watcher;
}
