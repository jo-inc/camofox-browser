import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchServer } from '../../lib/launcher.js';
import { loadConfig } from '../../lib/config.js';
import { createClient } from '../helpers/client.js';
import { getSharedEnv } from './sharedEnv.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

async function waitForServer(port) {
  for (let i = 0; i < 60; i++) {
    try {
      if ((await fetch(`http://localhost:${port}/health`)).ok) return;
    } catch { /* not ready */ }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`server on ${port} did not start`);
}

// A restricted port fails Playwright's restore navigation the same way an extension's block does, with no filter
// list or network involved.
describe('a saved profile with an origin the browser will not navigate to', () => {
  test('still opens a tab, keeping every cookie and the other origins', async () => {
    const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'camofox-restore-'));
    const userId = 'restore-' + crypto.randomUUID();
    const userDir = path.join(profileDir, crypto.createHash('sha256').update(userId).digest('hex').slice(0, 32));
    fs.mkdirSync(userDir, { recursive: true });
    const origins = ['https://example.com', 'https://example.org:25', 'https://www.wikipedia.org'];
    fs.writeFileSync(path.join(userDir, 'storage-state.json'), JSON.stringify({
      cookies: [{ name: 'sid', value: 'kept', domain: 'example.com', path: '/', expires: -1, httpOnly: false, secure: true, sameSite: 'Lax' }],
      origins: origins.map((origin, i) => ({ origin, localStorage: [{ name: 'k', value: 'v' + i }] })),
    }));

    const port = Math.floor(4100 + Math.random() * 800);
    const server = launchServer({
      pluginDir: path.resolve(__dirname, '../..'),
      port,
      env: { ...loadConfig().serverEnv, DEBUG_RESPONSES: 'false', CAMOFOX_PROFILE_DIR: profileDir },
      log: { info: () => {}, error: () => {} },
    });
    try {
      await waitForServer(port);
      const client = createClient(`http://localhost:${port}`);
      client.userId = userId;
      const tab = await client.createTab(`${getSharedEnv().testSiteUrl}/pageA`, { retries: 0 });
      expect(tab.tabId).toBeTruthy();

      const state = await client.request('GET', `/sessions/${encodeURIComponent(userId)}/storage_state`);
      expect(state.cookies.map((c) => `${c.name}=${c.value}`)).toContain('sid=kept');
      const restored = Object.fromEntries(state.origins.map((o) => [o.origin, o.localStorage.find((e) => e.name === 'k')?.value]));
      expect(restored).toEqual({ 'https://example.com': 'v0', 'https://www.wikipedia.org': 'v2' });
    } finally {
      server.kill('SIGKILL');
      fs.rmSync(profileDir, { recursive: true, force: true });
    }
  });
});
