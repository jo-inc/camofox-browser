import { createClient } from '../helpers/client.js';
import { getSharedEnv } from './sharedEnv.js';

describe('Concurrency', () => {
  let serverUrl;
  let testSiteUrl;
  
  beforeAll(() => {
    const env = getSharedEnv();
    serverUrl = env.serverUrl;
    testSiteUrl = env.testSiteUrl;
  });
  
  // Server lifecycle managed by globalSetup/globalTeardown
  
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

  test('recovery after one user reaches the navigation failure threshold leaves another user usable', async () => {
    const failingClient = createClient(serverUrl);
    const healthyClient = createClient(serverUrl);

    try {
      const [failingTab, healthyTab] = await Promise.all([
        failingClient.createTab(`${testSiteUrl}/pageA`),
        healthyClient.createTab(`${testSiteUrl}/pageB`),
      ]);
      const failingUrl = `${testSiteUrl}/connection-reset`;

      await expect(failingClient.navigate(failingTab.tabId, failingUrl)).rejects.toMatchObject({ status: 500 });
      await expect(failingClient.navigate(failingTab.tabId, failingUrl)).rejects.toMatchObject({ status: 500 });

      const [, healthySnapshot] = await Promise.all([
        expect(failingClient.navigate(failingTab.tabId, failingUrl)).rejects.toMatchObject({ status: 500 }),
        healthyClient.getSnapshot(healthyTab.tabId),
      ]);

      expect(healthySnapshot.snapshot).toContain('Page B');
      expect((await healthyClient.health()).browserConnected).toBe(true);

      const recoveredTab = await failingClient.createTab(`${testSiteUrl}/pageA`);
      expect((await failingClient.getSnapshot(recoveredTab.tabId)).snapshot).toContain('Page A');
    } finally {
      await failingClient.cleanup();
      await healthyClient.cleanup();
    }
  });
});
