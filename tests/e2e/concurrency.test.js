const { startJoBrowser, stopJoBrowser, getServerUrl } = require('../helpers/startJoBrowser');
const { startTestSite, stopTestSite, getTestSiteUrl } = require('../helpers/testSite');
const { createClient } = require('../helpers/client');

describe('Concurrency', () => {
  let serverUrl;
  let testSiteUrl;
  
  beforeAll(async () => {
    const port = await startJoBrowser();
    serverUrl = getServerUrl();
    
    const testPort = await startTestSite();
    testSiteUrl = getTestSiteUrl();
  }, 120000);
  
  afterAll(async () => {
    await stopTestSite();
    await stopJoBrowser();
  }, 30000);
  
  test('concurrent operations on same tab are serialized', async () => {
    const client = createClient(serverUrl);
    
    try {
      const { tabId } = await client.createTab(`${testSiteUrl}/pageA`);
      
      // Fire multiple operations concurrently on the same tab
      const operations = [
        client.getSnapshot(tabId),
        client.navigate(tabId, `${testSiteUrl}/pageB`),
        client.getSnapshot(tabId),
      ];
      
      // All should complete without errors (tab locking serializes them)
      const results = await Promise.all(operations);
      
      expect(results.length).toBe(3);
      // Each result should be valid (no crashes)
      results.forEach(r => expect(r).toBeDefined());
    } finally {
      await client.cleanup();
    }
  });
  
  test('parallel operations on different tabs work', async () => {
    const client = createClient(serverUrl);
    
    try {
      // Create two tabs
      const tab1 = await client.createTab(`${testSiteUrl}/pageA`);
      const tab2 = await client.createTab(`${testSiteUrl}/pageB`);
      
      // Run operations on both tabs in parallel
      const [snap1, snap2] = await Promise.all([
        client.getSnapshot(tab1.tabId),
        client.getSnapshot(tab2.tabId),
      ]);
      
      // Both should return valid snapshots
      expect(snap1.snapshot).toContain('Page A');
      expect(snap2.snapshot).toContain('Page B');
    } finally {
      await client.cleanup();
    }
  });
  
  test('multiple clients can work independently', async () => {
    const client1 = createClient(serverUrl);
    const client2 = createClient(serverUrl);
    
    try {
      // Each client creates their own tab
      const [tab1, tab2] = await Promise.all([
        client1.createTab(`${testSiteUrl}/pageA`),
        client2.createTab(`${testSiteUrl}/pageB`),
      ]);
      
      // Verify they are independent
      expect(tab1.tabId).not.toBe(tab2.tabId);
      expect(client1.userId).not.toBe(client2.userId);
      
      // Both can operate independently
      const [snap1, snap2] = await Promise.all([
        client1.getSnapshot(tab1.tabId),
        client2.getSnapshot(tab2.tabId),
      ]);
      
      expect(snap1.snapshot).toContain('Page A');
      expect(snap2.snapshot).toContain('Page B');
      
      // Closing one client's session doesn't affect the other
      await client1.closeSession();
      
      // Client 2 still works
      const snap2After = await client2.getSnapshot(tab2.tabId);
      expect(snap2After.snapshot).toContain('Page B');
    } finally {
      await client1.cleanup();
      await client2.cleanup();
    }
  });
});
