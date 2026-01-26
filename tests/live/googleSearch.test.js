const { startJoBrowser, stopJoBrowser, getServerUrl } = require('../helpers/startJoBrowser');
const { createClient } = require('../helpers/client');

// Live Google tests are opt-in due to potential captchas/rate limiting
const SKIP_LIVE_TESTS = !process.env.RUN_LIVE_TESTS;

describe('Live Google Search', () => {
  let serverUrl;
  
  beforeAll(async () => {
    if (SKIP_LIVE_TESTS) return;
    
    const port = await startJoBrowser();
    serverUrl = getServerUrl();
  }, 120000);
  
  afterAll(async () => {
    if (SKIP_LIVE_TESTS) return;
    await stopJoBrowser();
  }, 30000);
  
  (SKIP_LIVE_TESTS ? test.skip : test)('Google search via @google_search macro', async () => {
    const client = createClient(serverUrl);
    
    try {
      const { tabId } = await client.createTab();
      
      // Use the @google_search macro
      const result = await client.navigate(tabId, '@google_search Camoufox playwright browser');
      
      expect(result.ok).toBe(true);
      expect(result.url).toContain('google.com');
      
      // Get snapshot - should contain search results
      const snapshot = await client.getSnapshot(tabId);
      
      expect(snapshot.snapshot).toBeDefined();
      expect(snapshot.snapshot.length).toBeGreaterThan(100);
      
      // Should contain at least one of the search terms
      const containsSearchTerm = 
        snapshot.snapshot.toLowerCase().includes('camoufox') ||
        snapshot.snapshot.toLowerCase().includes('playwright') ||
        snapshot.snapshot.toLowerCase().includes('browser');
      
      expect(containsSearchTerm).toBe(true);
      
      // Get links - should have search result links
      const linksResult = await client.getLinks(tabId, { limit: 20 });
      expect(linksResult.links.length).toBeGreaterThan(0);
      
    } finally {
      await client.cleanup();
    }
  }, 120000); // 2 minute timeout for live test
  
  (SKIP_LIVE_TESTS ? test.skip : test)('click on Google search result', async () => {
    const client = createClient(serverUrl);
    
    try {
      const { tabId } = await client.createTab();
      
      // Search for something specific
      await client.navigate(tabId, '@google_search playwright documentation');
      
      // Get snapshot to find a result link
      const snapshot = await client.getSnapshot(tabId);
      
      // Look for playwright.dev link in refs
      const playwriteMatch = snapshot.snapshot.match(/\[(e\d+)\].*playwright\.dev/i);
      
      if (playwriteMatch) {
        const ref = playwriteMatch[1];
        
        // Click the link
        await client.click(tabId, { ref });
        
        // Wait for navigation
        await new Promise(r => setTimeout(r, 3000));
        
        const newSnapshot = await client.getSnapshot(tabId);
        expect(newSnapshot.url).toContain('playwright');
      } else {
        // If no playwright.dev link found, test still passes
        // (Google results can vary)
        console.log('No playwright.dev link found in search results, skipping click test');
      }
      
    } finally {
      await client.cleanup();
    }
  }, 120000);
});
