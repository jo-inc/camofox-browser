import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'node:url';
import { launchServer } from '../../lib/launcher.js';
import { loadConfig } from '../../lib/config.js';
import { createClient } from '../helpers/client.js';
import { getSharedEnv } from './sharedEnv.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const describeLinux = process.platform === 'linux' ? describe : describe.skip;

// A process's state and parent pid, or null once it has gone (a zombie counts as gone).
function procStat(pid) {
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    const [state, ppid] = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
    return state === 'Z' ? null : { state, ppid: Number(ppid) };
  } catch {
    return null;
  }
}

function xvfbChildren(parentPid) {
  return fs.readdirSync('/proc').filter((d) => /^\d+$/.test(d)).map(Number).filter((pid) => {
    try {
      return fs.readFileSync(`/proc/${pid}/comm`, 'utf8').trim() === 'Xvfb' && procStat(pid)?.ppid === parentPid;
    } catch {
      return false;
    }
  });
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

// camoufox-js starts Xvfb in its own process group and only the browser's close stops it, so a server that
// dies any other way (SIGKILL from a test runner, the shutdown watchdog, a crash) used to leave Xvfb running
// for good. The kernel now kills Xvfb when its server dies.
describeLinux('Xvfb does not outlive its server', () => {
  const cases = [
    ['the default display', {}],
    ['the VNC plugin display', { ENABLE_VNC: '1' }],
  ];

  test.each(cases)('a SIGKILLed server takes %s with it', async (_name, extraEnv) => {
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

      server.kill('SIGKILL');
      const gone = await waitFor(() => xvfb.every((pid) => procStat(pid) === null), 5000);
      expect(xvfb.filter((pid) => procStat(pid) !== null)).toEqual([]);
      expect(gone).toBe(true);
    } finally {
      if (server.exitCode === null) server.kill('SIGKILL');
      for (const pid of xvfb || []) {
        try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ }
      }
    }
  });
});
