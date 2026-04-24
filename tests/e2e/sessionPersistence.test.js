import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { startServer, stopServer, getServerUrl } from '../helpers/startServer.js';
import { startTestSite, stopTestSite, getTestSiteUrl } from '../helpers/testSite.js';
import { createClient } from '../helpers/client.js';
import { getUserPersistencePaths } from '../../lib/persistence.js';

describe('Session Persistence', () => {
  let serverUrl;
  let testSiteUrl;
  let profileDir;

  beforeAll(async () => {
    profileDir = await fs.mkdtemp(path.join(os.tmpdir(), 'camofox-e2e-profiles-'));
    await startServer(0, { CAMOFOX_PROFILE_DIR: profileDir });
    serverUrl = getServerUrl();

    await startTestSite();
    testSiteUrl = getTestSiteUrl();
  }, 120000);

  afterAll(async () => {
    await stopTestSite();
    await stopServer();
    if (profileDir) {
      await fs.rm(profileDir, { recursive: true, force: true });
    }
  }, 30000);

  test('DELETE /sessions checkpoints live storage state before closing context', async () => {
    const client = createClient(serverUrl);
    client.timeout = 60000;

    const { tabId } = await client.createTab(`${testSiteUrl}/pageA`);
    const writeResult = await client.request('POST', `/tabs/${tabId}/evaluate`, {
      userId: client.userId,
      expression: `(() => {
        document.cookie = "persisted_cookie=abc123; path=/; SameSite=Lax";
        localStorage.setItem("persistedLocal", "local-value");
        return {
          cookie: document.cookie,
          local: localStorage.getItem("persistedLocal")
        };
      })()`,
    });

    expect(writeResult.result.cookie).toContain('persisted_cookie=abc123');
    expect(writeResult.result.local).toBe('local-value');

    await client.closeSession();

    const { storageStatePath } = getUserPersistencePaths(profileDir, client.userId);
    const saved = JSON.parse(await fs.readFile(storageStatePath, 'utf8'));

    expect(saved.cookies).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: 'persisted_cookie', value: 'abc123' }),
      ])
    );
    expect(saved.origins).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          origin: testSiteUrl,
          localStorage: expect.arrayContaining([
            expect.objectContaining({ name: 'persistedLocal', value: 'local-value' }),
          ]),
        }),
      ])
    );

    const restoredClient = createClient(serverUrl);
    restoredClient.userId = client.userId;
    restoredClient.timeout = 60000;

    try {
      const restoredTab = await restoredClient.createTab(`${testSiteUrl}/pageA`);
      const restoredState = await restoredClient.request('POST', `/tabs/${restoredTab.tabId}/evaluate`, {
        userId: restoredClient.userId,
        expression: `(() => ({
          cookie: document.cookie,
          local: localStorage.getItem("persistedLocal")
        }))()`,
      });

      expect(restoredState.result.cookie).toContain('persisted_cookie=abc123');
      expect(restoredState.result.local).toBe('local-value');
    } finally {
      await restoredClient.cleanup();
    }
  }, 120000);
});
