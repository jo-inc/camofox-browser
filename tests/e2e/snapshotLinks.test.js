const { startJoBrowser, stopJoBrowser, getServerUrl } = require('../helpers/startJoBrowser');
const { startTestSite, stopTestSite, getTestSiteUrl } = require('../helpers/testSite');
const { createClient } = require('../helpers/client');

describe('Snapshot and Links', () => {
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
  
  test('get snapshot returns page content', async () => {
    const client = createClient(serverUrl);
    
    try {
      const { tabId } = await client.createTab(`${testSiteUrl}/pageA`);
      
      const snapshot = await client.getSnapshot(tabId);
      
      expect(snapshot.url).toContain('/pageA');
      expect(snapshot.snapshot).toBeDefined();
      expect(typeof snapshot.snapshot).toBe('string');
      expect(snapshot.snapshot).toContain('Page A');
      expect(snapshot.refsCount).toBeDefined();
    } finally {
      await client.cleanup();
    }
  });
  
  test('snapshot contains element refs', async () => {
    const client = createClient(serverUrl);
    
    try {
      const { tabId } = await client.createTab(`${testSiteUrl}/links`);
      
      const snapshot = await client.getSnapshot(tabId);
      
      // Snapshot should contain ref markers like [e1], [e2], etc.
      expect(snapshot.snapshot).toMatch(/\[e\d+\]/);
    } finally {
      await client.cleanup();
    }
  });
  
  test('get links returns all links on page', async () => {
    const client = createClient(serverUrl);
    
    try {
      const { tabId } = await client.createTab(`${testSiteUrl}/links`);
      
      const result = await client.getLinks(tabId);
      
      expect(result.links).toBeDefined();
      expect(Array.isArray(result.links)).toBe(true);
      expect(result.links.length).toBe(5);
      
      // Check link structure
      const link = result.links[0];
      expect(link.url).toContain('example.com');
      expect(link.text).toBeDefined();
      
      // Check pagination info
      expect(result.pagination).toBeDefined();
      expect(result.pagination.total).toBe(5);
    } finally {
      await client.cleanup();
    }
  });
  
  test('get links supports pagination', async () => {
    const client = createClient(serverUrl);
    
    try {
      const { tabId } = await client.createTab(`${testSiteUrl}/links`);
      
      // Get first 2 links
      const page1 = await client.getLinks(tabId, { limit: 2, offset: 0 });
      expect(page1.links.length).toBe(2);
      expect(page1.pagination.hasMore).toBe(true);
      
      // Get next 2 links
      const page2 = await client.getLinks(tabId, { limit: 2, offset: 2 });
      expect(page2.links.length).toBe(2);
      expect(page2.pagination.hasMore).toBe(true);
      
      // Get last link
      const page3 = await client.getLinks(tabId, { limit: 2, offset: 4 });
      expect(page3.links.length).toBe(1);
      expect(page3.pagination.hasMore).toBe(false);
      
      // Links should be different
      expect(page1.links[0].url).not.toBe(page2.links[0].url);
    } finally {
      await client.cleanup();
    }
  });
  
  test('screenshot returns PNG buffer', async () => {
    const client = createClient(serverUrl);
    
    try {
      const { tabId } = await client.createTab(`${testSiteUrl}/pageA`);
      
      const buffer = await client.screenshot(tabId);
      
      expect(buffer).toBeDefined();
      expect(buffer.byteLength).toBeGreaterThan(0);
      
      // Check PNG magic bytes
      const bytes = new Uint8Array(buffer);
      expect(bytes[0]).toBe(0x89);
      expect(bytes[1]).toBe(0x50); // P
      expect(bytes[2]).toBe(0x4E); // N
      expect(bytes[3]).toBe(0x47); // G
    } finally {
      await client.cleanup();
    }
  });
  
  test('snapshot for non-existent tab returns 404', async () => {
    const client = createClient(serverUrl);
    
    try {
      await expect(client.getSnapshot('non-existent-tab-id')).rejects.toMatchObject({
        status: 404
      });
    } finally {
      await client.cleanup();
    }
  });
});
