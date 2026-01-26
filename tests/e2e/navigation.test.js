const { startJoBrowser, stopJoBrowser, getServerUrl } = require('../helpers/startJoBrowser');
const { startTestSite, stopTestSite, getTestSiteUrl } = require('../helpers/testSite');
const { createClient } = require('../helpers/client');

describe('Navigation', () => {
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
  
  test('navigate to URL', async () => {
    const client = createClient(serverUrl);
    
    try {
      const { tabId } = await client.createTab();
      
      const result = await client.navigate(tabId, `${testSiteUrl}/pageA`);
      
      expect(result.ok).toBe(true);
      expect(result.url).toContain('/pageA');
      
      const snapshot = await client.getSnapshot(tabId);
      expect(snapshot.snapshot).toContain('Welcome to Page A');
    } finally {
      await client.cleanup();
    }
  });
  
  test('navigate back', async () => {
    const client = createClient(serverUrl);
    
    try {
      const { tabId } = await client.createTab(`${testSiteUrl}/pageA`);
      await client.navigate(tabId, `${testSiteUrl}/pageB`);
      
      // Verify we're on page B
      let snapshot = await client.getSnapshot(tabId);
      expect(snapshot.snapshot).toContain('Page B');
      
      // Go back
      const result = await client.back(tabId);
      expect(result.ok).toBe(true);
      expect(result.url).toContain('/pageA');
      
      snapshot = await client.getSnapshot(tabId);
      expect(snapshot.snapshot).toContain('Page A');
    } finally {
      await client.cleanup();
    }
  });
  
  test('navigate forward', async () => {
    const client = createClient(serverUrl);
    
    try {
      const { tabId } = await client.createTab(`${testSiteUrl}/pageA`);
      await client.navigate(tabId, `${testSiteUrl}/pageB`);
      await client.back(tabId);
      
      // Verify we're back on page A
      let snapshot = await client.getSnapshot(tabId);
      expect(snapshot.snapshot).toContain('Page A');
      
      // Go forward
      const result = await client.forward(tabId);
      expect(result.ok).toBe(true);
      expect(result.url).toContain('/pageB');
      
      snapshot = await client.getSnapshot(tabId);
      expect(snapshot.snapshot).toContain('Page B');
    } finally {
      await client.cleanup();
    }
  });
  
  test('refresh page', async () => {
    const client = createClient(serverUrl);
    
    try {
      // Use the refresh counter page
      const { tabId } = await client.createTab(`${testSiteUrl}/refresh-test`);
      
      let snapshot = await client.getSnapshot(tabId);
      const initialMatch = snapshot.snapshot.match(/Count: (\d+)/);
      const initialCount = initialMatch ? parseInt(initialMatch[1]) : 0;
      
      // Refresh the page
      const result = await client.refresh(tabId);
      expect(result.ok).toBe(true);
      
      snapshot = await client.getSnapshot(tabId);
      const newMatch = snapshot.snapshot.match(/Count: (\d+)/);
      const newCount = newMatch ? parseInt(newMatch[1]) : 0;
      
      // Count should have incremented
      expect(newCount).toBe(initialCount + 1);
    } finally {
      await client.cleanup();
    }
  });
  
  test('navigation updates visited URLs', async () => {
    const client = createClient(serverUrl);
    
    try {
      const { tabId } = await client.createTab(`${testSiteUrl}/pageA`);
      await client.navigate(tabId, `${testSiteUrl}/pageB`);
      
      const stats = await client.getStats(tabId);
      
      expect(stats.visitedUrls).toContain(`${testSiteUrl}/pageA`);
      expect(stats.visitedUrls).toContain(`${testSiteUrl}/pageB`);
    } finally {
      await client.cleanup();
    }
  });
});
