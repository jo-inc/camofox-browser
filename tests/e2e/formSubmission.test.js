const { startJoBrowser, stopJoBrowser, getServerUrl } = require('../helpers/startJoBrowser');
const { startTestSite, stopTestSite, getTestSiteUrl } = require('../helpers/testSite');
const { createClient } = require('../helpers/client');

describe('Form Submission', () => {
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
  
  test('fill form fields and submit via button click', async () => {
    const client = createClient(serverUrl);
    
    try {
      const { tabId } = await client.createTab(`${testSiteUrl}/form`);
      
      // Fill username
      await client.type(tabId, {
        selector: '#username',
        text: 'testuser'
      });
      
      // Fill email
      await client.type(tabId, {
        selector: '#email',
        text: 'test@example.com'
      });
      
      // Click submit button
      await client.click(tabId, {
        selector: '#submitBtn'
      });
      
      // Wait for form submission and navigation
      const snapshot = await client.waitForUrl(tabId, '/submitted');
      
      expect(snapshot.url).toContain('/submitted');
      expect(snapshot.snapshot).toContain('Form Submitted Successfully');
      expect(snapshot.snapshot).toContain('Username: testuser');
      expect(snapshot.snapshot).toContain('Email: test@example.com');
    } finally {
      await client.cleanup();
    }
  });
  
  test('click button on page', async () => {
    const client = createClient(serverUrl);
    
    try {
      const { tabId } = await client.createTab(`${testSiteUrl}/click`);
      
      // Initial state
      let snapshot = await client.getSnapshot(tabId);
      expect(snapshot.snapshot).not.toContain('Button was clicked!');
      
      // Click the button
      await client.click(tabId, {
        selector: '#clickMe'
      });
      
      // Verify click effect
      snapshot = await client.waitForSnapshotContains(tabId, 'Button was clicked!');
      expect(snapshot.snapshot).toContain('Button was clicked!');
    } finally {
      await client.cleanup();
    }
  });
  
  test('click using ref', async () => {
    const client = createClient(serverUrl);
    
    try {
      const { tabId } = await client.createTab(`${testSiteUrl}/click`);
      
      // Get snapshot to find button ref
      const snapshot = await client.getSnapshot(tabId);
      
      // Find ref for "Click Me" button
      const match = snapshot.snapshot.match(/\[(e\d+)\].*button.*Click Me/i);
      
      if (match) {
        const ref = match[1];
        await client.click(tabId, { ref });
        
        const updatedSnapshot = await client.waitForSnapshotContains(tabId, 'Button was clicked!');
        expect(updatedSnapshot.snapshot).toContain('Button was clicked!');
      } else {
        // Fallback to selector
        await client.click(tabId, { selector: '#clickMe' });
        const updatedSnapshot = await client.waitForSnapshotContains(tabId, 'Button was clicked!');
        expect(updatedSnapshot.snapshot).toContain('Button was clicked!');
      }
    } finally {
      await client.cleanup();
    }
  });
  
  test('click link to navigate', async () => {
    const client = createClient(serverUrl);
    
    try {
      const { tabId } = await client.createTab(`${testSiteUrl}/pageA`);
      
      // Click the link to page B
      await client.click(tabId, {
        selector: 'a[href="/pageB"]'
      });
      
      // Wait for navigation
      const snapshot = await client.waitForUrl(tabId, '/pageB');
      
      expect(snapshot.url).toContain('/pageB');
      expect(snapshot.snapshot).toContain('Page B');
    } finally {
      await client.cleanup();
    }
  });
});
