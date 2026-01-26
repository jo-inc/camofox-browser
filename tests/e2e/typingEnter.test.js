const { startJoBrowser, stopJoBrowser, getServerUrl } = require('../helpers/startJoBrowser');
const { startTestSite, stopTestSite, getTestSiteUrl } = require('../helpers/testSite');
const { createClient } = require('../helpers/client');

describe('Typing and Enter', () => {
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
  
  test('type text into input field', async () => {
    const client = createClient(serverUrl);
    
    try {
      const { tabId } = await client.createTab(`${testSiteUrl}/typing`);
      
      // Type using selector
      const result = await client.type(tabId, {
        selector: '#input',
        text: 'Hello World'
      });
      
      expect(result.ok).toBe(true);
      
      // Verify the text appears in preview
      const snapshot = await client.waitForSnapshotContains(tabId, 'Preview: Hello World');
      expect(snapshot.snapshot).toContain('Hello World');
    } finally {
      await client.cleanup();
    }
  });
  
  test('type text using ref', async () => {
    const client = createClient(serverUrl);
    
    try {
      const { tabId } = await client.createTab(`${testSiteUrl}/typing`);
      
      // Get snapshot to find the input ref
      const snapshot = await client.getSnapshot(tabId);
      
      // Find a ref for the textbox (look for pattern like [e1] textbox)
      const match = snapshot.snapshot.match(/\[(e\d+)\].*textbox/i);
      if (!match) {
        // Try by selector if ref not found
        await client.type(tabId, { selector: '#input', text: 'Test via selector' });
      } else {
        const ref = match[1];
        await client.type(tabId, { ref, text: 'Test via ref' });
      }
      
      const updatedSnapshot = await client.getSnapshot(tabId);
      expect(updatedSnapshot.snapshot).toMatch(/Preview: Test via (ref|selector)/);
    } finally {
      await client.cleanup();
    }
  });
  
  test('type and press Enter navigates page', async () => {
    const client = createClient(serverUrl);
    
    try {
      const { tabId } = await client.createTab(`${testSiteUrl}/enter`);
      
      // Type and press Enter
      await client.type(tabId, {
        selector: '#searchInput',
        text: 'test query',
        pressEnter: true
      });
      
      // Wait for navigation to /entered
      const snapshot = await client.waitForUrl(tabId, '/entered');
      
      expect(snapshot.url).toContain('/entered');
      expect(snapshot.url).toContain('value=test%20query');
      expect(snapshot.snapshot).toContain('Entered: test query');
    } finally {
      await client.cleanup();
    }
  });
  
  test('type without Enter does not navigate', async () => {
    const client = createClient(serverUrl);
    
    try {
      const { tabId } = await client.createTab(`${testSiteUrl}/enter`);
      
      // Type without pressing Enter
      await client.type(tabId, {
        selector: '#searchInput',
        text: 'should not navigate',
        pressEnter: false
      });
      
      // Wait a bit to ensure no navigation happened
      await new Promise(r => setTimeout(r, 500));
      
      const snapshot = await client.getSnapshot(tabId);
      expect(snapshot.url).toContain('/enter');
      expect(snapshot.url).not.toContain('/entered');
    } finally {
      await client.cleanup();
    }
  });
  
  test('type replaces existing content', async () => {
    const client = createClient(serverUrl);
    
    try {
      const { tabId } = await client.createTab(`${testSiteUrl}/typing`);
      
      // Type first text
      await client.type(tabId, {
        selector: '#input',
        text: 'First text'
      });
      
      let snapshot = await client.waitForSnapshotContains(tabId, 'Preview: First text');
      expect(snapshot.snapshot).toContain('First text');
      
      // Type second text (should replace due to clear behavior)
      await client.type(tabId, {
        selector: '#input',
        text: 'Second text',
        clear: true
      });
      
      snapshot = await client.waitForSnapshotContains(tabId, 'Preview: Second text');
      expect(snapshot.snapshot).toContain('Second text');
      expect(snapshot.snapshot).not.toContain('First text');
    } finally {
      await client.cleanup();
    }
  });
});
