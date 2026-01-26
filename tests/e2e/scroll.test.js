const { startJoBrowser, stopJoBrowser, getServerUrl } = require('../helpers/startJoBrowser');
const { startTestSite, stopTestSite, getTestSiteUrl } = require('../helpers/testSite');
const { createClient } = require('../helpers/client');

describe('Scroll', () => {
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
  
  test('scroll down page', async () => {
    const client = createClient(serverUrl);
    
    try {
      const { tabId } = await client.createTab(`${testSiteUrl}/scroll`);
      
      // Scroll down
      const result = await client.scroll(tabId, {
        direction: 'down',
        amount: 500
      });
      
      expect(result.ok).toBe(true);
    } finally {
      await client.cleanup();
    }
  });
  
  test('scroll to bottom of page', async () => {
    const client = createClient(serverUrl);
    
    try {
      const { tabId } = await client.createTab(`${testSiteUrl}/scroll`);
      
      // Scroll to bottom
      const result = await client.scroll(tabId, {
        direction: 'down',
        amount: 10000 // Large number to reach bottom
      });
      
      expect(result.ok).toBe(true);
      
      // The snapshot might now include "Bottom of page" text
      // (depending on viewport and scroll behavior)
    } finally {
      await client.cleanup();
    }
  });
  
  test('scroll up page', async () => {
    const client = createClient(serverUrl);
    
    try {
      const { tabId } = await client.createTab(`${testSiteUrl}/scroll`);
      
      // First scroll down
      await client.scroll(tabId, { direction: 'down', amount: 1000 });
      
      // Then scroll up
      const result = await client.scroll(tabId, {
        direction: 'up',
        amount: 500
      });
      
      expect(result.ok).toBe(true);
    } finally {
      await client.cleanup();
    }
  });
});
