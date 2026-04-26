/**
 * Jest globalSetup for e2e tests.
 * Starts ONE camofox server + test site shared across ALL e2e test files.
 * Writes connection URLs to a temp file so test files can read them.
 */
import fs from 'fs';
import path from 'path';
import os from 'os';
import { fileURLToPath } from 'node:url';
import { launchServer } from '../../lib/launcher.js';
import { loadConfig } from '../../lib/config.js';
import { DISPLAY } from '../helpers/test-env.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const ENV_FILE = path.join(os.tmpdir(), 'camofox-e2e-env.json');

async function waitForServer(port, maxRetries = 30, interval = 1000) {
  for (let i = 0; i < maxRetries; i++) {
    try {
      const response = await fetch(`http://localhost:${port}/health`);
      if (response.ok) return true;
    } catch (e) { /* not ready */ }
    await new Promise(r => setTimeout(r, interval));
  }
  throw new Error(`Server failed to start on port ${port} after ${maxRetries} attempts`);
}

export default async function globalSetup() {
  // --- Start camofox server ---
  const serverPort = Math.floor(3100 + Math.random() * 900);
  const cfg = loadConfig();
  const pluginDir = path.resolve(__dirname, '../..');

  const log = {
    info: (msg) => console.log(msg),
    error: (msg) => console.error(msg),
  };

  const serverProcess = launchServer({
    pluginDir,
    port: serverPort,
    env: { ...cfg.serverEnv, DEBUG_RESPONSES: 'false', DISPLAY },
    log,
  });

  serverProcess.on('error', (err) => {
    console.error('Failed to start server:', err);
  });

  await waitForServer(serverPort);
  console.log(`[globalSetup] camofox server on port ${serverPort}`);

  // --- Start test site (express) ---
  const { startTestSite, getTestSiteUrl } = await import('../helpers/testSite.js');
  await startTestSite();
  const testSiteUrl = getTestSiteUrl();
  console.log(`[globalSetup] test site at ${testSiteUrl}`);

  // Write env to temp file for test workers to read
  fs.writeFileSync(ENV_FILE, JSON.stringify({
    serverUrl: `http://localhost:${serverPort}`,
    testSiteUrl,
    serverPid: serverProcess.pid,
  }));

  // Store for globalTeardown (same process, globalThis persists)
  globalThis.__CAMOFOX_SERVER_PROCESS__ = serverProcess;
  globalThis.__CAMOFOX_ENV_FILE__ = ENV_FILE;
}
