import { startServer, stopServer, getServerUrl } from '../helpers/startServer.js';
import { startTestSite, stopTestSite, getTestSiteUrl } from '../helpers/testSite.js';
import { createClient } from '../helpers/client.js';

/**
 * Integration tests for the 410 "browser_restarted" contract: after the
 * browser is stopped/restarted, a still-referenced tab ID must come back as
 * 410 `browser_restarted` (so clients recreate the tab) rather than 404.
 *
 * These tests run against a real server + real Camoufox, same pattern as
 * tabRecycling.test.js. The server is started with CAMOFOX_ADMIN_KEY so the
 * test can restart the browser via POST /stop.
 */
describe('410 browser_restarted after browser stop', () => {
  let serverUrl;
  let testSiteUrl;
  const adminKey = 'test-admin-key-410';

  beforeAll(async () => {
    await startServer(0, { CAMOFOX_ADMIN_KEY: adminKey });
    serverUrl = getServerUrl();
    await startTestSite();
    testSiteUrl = getTestSiteUrl();
  }, 120000);

  afterAll(async () => {
    await stopTestSite();
    await stopServer();
  }, 30000);

  test('tab referenced after a browser stop returns 410 browser_restarted, garbage ID returns 404', async () => {
    const client = createClient(serverUrl);
    let tabId;
    try {
      const tab = await client.createTab(`${testSiteUrl}/pageA`);
      tabId = tab.tabId;
      expect(tabId).toBeDefined();

      // Sanity: the tab works while the browser is up.
      const snap = await client.getSnapshot(tabId);
      expect(snap.url).toContain('/pageA');

      // Stop the browser (closes all sessions + the browser process).
      const stopResp = await fetch(`${serverUrl}/stop`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-admin-key': adminKey },
      });
      expect(stopResp.ok).toBe(true);
      const stop = await stopResp.json();
      expect(stop.ok).toBe(true);

      // The dead tab ID now answers 410 with the browser_restarted code —
      // clients use this to recreate the tab instead of treating it as a
      // permanent "never existed" 404.
      await expect(client.getSnapshot(tabId)).rejects.toMatchObject({
        status: 410,
        data: { code: 'browser_restarted' },
      });

      // A random non-UUID ID still gets a plain 404.
      await expect(client.getSnapshot('non-existent-tab')).rejects.toMatchObject({
        status: 404,
      });
    } finally {
      // Relaunch the browser if still stopped so stopServer tears down cleanly.
      try {
        await fetch(`${serverUrl}/start`, { method: 'POST' });
      } catch { /* best effort */ }
      await client.cleanup();
    }
  }, 120000);
});
