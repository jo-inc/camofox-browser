import { startServer, stopServer, getServerUrl } from '../helpers/startServer.js';
import { startTestSite, stopTestSite, getTestSiteUrl } from '../helpers/testSite.js';
import { createClient } from '../helpers/client.js';

describe('Tab Recycling', () => {
  let serverUrl;
  let testSiteUrl;

  beforeAll(async () => {
    await startServer(0, { MAX_TABS_PER_SESSION: '5', MAX_TABS_GLOBAL: '50' });
    serverUrl = getServerUrl();
    await startTestSite();
    testSiteUrl = getTestSiteUrl();
  }, 120000);

  afterAll(async () => {
    await stopTestSite();
    await stopServer();
  }, 30000);

  test('POST /tabs recycles oldest tab when per-session limit reached', async () => {
    const client = createClient(serverUrl);
    try {
      const tabs = [];
      // Fill up to the limit (5)
      for (let i = 0; i < 5; i++) {
        const result = await client.createTab(`${testSiteUrl}/pageA`);
        tabs.push(result.tabId);
      }

      // 6th tab should succeed via recycling
      const result = await client.createTab(`${testSiteUrl}/pageB`);
      expect(result.tabId).toBeDefined();
      expect(result.url).toContain('/pageB');

      // The oldest tab (tabs[0]) should be gone
      try {
        await client.getSnapshot(tabs[0]);
        fail('Oldest tab should have been recycled');
      } catch (err) {
        expect(err.status).toBe(404);
      }

      // The new tab should work
      const snap = await client.getSnapshot(result.tabId);
      expect(snap.url).toContain('/pageB');
    } finally {
      await client.cleanup();
    }
  }, 120000);

  test('can browse many sites sequentially beyond the tab limit', async () => {
    const client = createClient(serverUrl);
    try {
      // Simulate a cron job visiting 12 different URLs (limit is 5)
      const urls = [];
      for (let i = 0; i < 12; i++) {
        urls.push(`${testSiteUrl}/page${i}`);
      }

      const tabs = [];
      for (const url of urls) {
        const result = await client.createTab(url);
        expect(result.tabId).toBeDefined();
        tabs.push(result.tabId);
      }

      // The last tab should be functional
      const lastTab = tabs[tabs.length - 1];
      const snap = await client.getSnapshot(lastTab);
      expect(snap.url).toContain('/page11');
    } finally {
      await client.cleanup();
    }
  }, 120000);

  test('recycled tabs are the least-used ones', async () => {
    const client = createClient(serverUrl);
    try {
      const tabs = [];
      for (let i = 0; i < 5; i++) {
        const result = await client.createTab(`${testSiteUrl}/pageA`);
        tabs.push(result.tabId);
      }

      // Interact with tabs[1] through tabs[4] to increase their toolCalls
      for (let i = 1; i < 5; i++) {
        await client.getSnapshot(tabs[i]);
      }

      // Create a 6th tab — should recycle tabs[0] (fewest toolCalls)
      const result = await client.createTab(`${testSiteUrl}/pageB`);
      expect(result.tabId).toBeDefined();

      // tabs[0] should be recycled (least used)
      try {
        await client.getSnapshot(tabs[0]);
        fail('Least-used tab should have been recycled');
      } catch (err) {
        expect(err.status).toBe(404);
      }

      // tabs[1] should still exist (it had more toolCalls)
      const snap = await client.getSnapshot(tabs[1]);
      expect(snap).toBeDefined();
    } finally {
      await client.cleanup();
    }
  }, 120000);

  test('navigate auto-creates with recycling when tab not found and limit reached', async () => {
    const client = createClient(serverUrl);
    try {
      const tabs = [];
      for (let i = 0; i < 5; i++) {
        const result = await client.createTab(`${testSiteUrl}/pageA`);
        tabs.push(result.tabId);
      }

      // Navigate with a non-existent tabId — should recycle and auto-create
      const fakeTabId = 'nonexistent-tab-id';
      const result = await client.navigate(fakeTabId, `${testSiteUrl}/pageC`);
      expect(result.url).toContain('/pageC');
    } finally {
      await client.cleanup();
    }
  }, 120000);

  test('different users can each use their full per-session limit', async () => {
    const client1 = createClient(serverUrl);
    const client2 = createClient(serverUrl);
    try {
      // User 1 fills their session
      for (let i = 0; i < 5; i++) {
        const result = await client1.createTab(`${testSiteUrl}/pageA`);
        expect(result.tabId).toBeDefined();
      }

      // User 2 should also be able to create tabs (global limit is 50)
      for (let i = 0; i < 5; i++) {
        const result = await client2.createTab(`${testSiteUrl}/pageB`);
        expect(result.tabId).toBeDefined();
      }
    } finally {
      await client1.cleanup();
      await client2.cleanup();
    }
  }, 120000);
});
