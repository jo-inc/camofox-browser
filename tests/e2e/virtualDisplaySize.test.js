import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'node:url';
import { launchServer } from '../../lib/launcher.js';
import { loadConfig } from '../../lib/config.js';
import { createClient } from '../helpers/client.js';
import { getSharedEnv } from './sharedEnv.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const describeLinux = process.platform === 'linux' ? describe : describe.skip;

function xvfbChildren(parentPid) {
  return fs.readdirSync('/proc').filter((d) => /^\d+$/.test(d)).map(Number).filter((pid) => {
    try {
      const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
      const ppid = Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[1]);
      return fs.readFileSync(`/proc/${pid}/comm`, 'utf8').trim() === 'Xvfb' && ppid === parentPid;
    } catch {
      return false;
    }
  });
}

function screenGeometry(pid) {
  const argv = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0');
  return argv[argv.indexOf('-screen') + 2];
}

async function waitFor(check, ms) {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = check();
    if (value || Date.now() > deadline) return value;
    await new Promise((r) => setTimeout(r, 100));
  }
}

async function waitForServer(port) {
  for (let i = 0; i < 60; i++) {
    try {
      if ((await fetch(`http://localhost:${port}/health`)).ok) return;
    } catch { /* not ready */ }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`server on ${port} did not start`);
}

describeLinux('the virtual display has the size camofox asks for', () => {
  const cases = [
    ['the default display', {}, '1280x720x24'],
    ['the VNC plugin display', { ENABLE_VNC: '1', VNC_RESOLUTION: '1920x1080' }, '1920x1080x24'],
  ];

  test.each(cases)('%s', async (_name, extraEnv, geometry) => {
    const port = Math.floor(4100 + Math.random() * 800);
    const vncEnv = extraEnv.ENABLE_VNC ? { VNC_PORT: String(port + 1000), NOVNC_PORT: String(port + 2000), VNC_BIND: '127.0.0.1' } : {};
    const server = launchServer({
      pluginDir: path.resolve(__dirname, '../..'),
      port,
      env: { ...loadConfig().serverEnv, DEBUG_RESPONSES: 'false', ...extraEnv, ...vncEnv },
      log: { info: () => {}, error: () => {} },
    });
    let xvfb = [];
    try {
      await waitForServer(port);
      const client = createClient(`http://localhost:${port}`);
      await client.createTab(`${getSharedEnv().testSiteUrl}/pageA`);
      xvfb = await waitFor(() => { const found = xvfbChildren(server.pid); return found.length ? found : null; }, 10000);
      expect(xvfb).not.toBeNull();
      expect(xvfb.map(screenGeometry)).toEqual(xvfb.map(() => geometry));
    } finally {
      server.kill('SIGKILL');
      for (const pid of xvfb || []) {
        try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ }
      }
    }
  });
});
