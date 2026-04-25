import { createClient } from '../helpers/client.js';
import { getSharedEnv } from './sharedEnv.js';

describe('Macro Navigation', () => {
  let serverUrl;
  let testSiteUrl;
  
  beforeAll(() => {
    const env = getSharedEnv();
    serverUrl = env.serverUrl;
    testSiteUrl = env.testSiteUrl;
  });
  
  // Server lifecycle managed by globalSetup/globalTeardown
  
  test('unknown macro returns error when no fallback URL', async () => {
    const client = createClient(serverUrl);
    
    try {
      const { tabId } = await client.createTab();
      
      await expect(client.navigate(tabId, '@nonexistent_macro test query'))
        .rejects.toThrow(/url or macro required/);
    } finally {
      await client.cleanup();
    }
  });
  
  test('client parses @macro syntax correctly', async () => {
    const client = createClient(serverUrl);
    
    try {
      const { tabId } = await client.createTab();
      
      // Navigate to a real URL first so we have a valid tab
      await client.navigate(tabId, `${testSiteUrl}/pageA`);
      
      // Now try an unknown macro - if client parsing works, 
      // server will receive {macro: "@unknown", query: "with spaces"}
      // and return "url or macro required" error
      await expect(client.navigate(tabId, '@unknown with spaces'))
        .rejects.toThrow(/url or macro required/);
    } finally {
      await client.cleanup();
    }
  });
  
  test('regular URL still works after macro changes', async () => {
    const client = createClient(serverUrl);
    
    try {
      const { tabId } = await client.createTab();
      
      // Regular URL should still work
      const result = await client.navigate(tabId, `${testSiteUrl}/pageA`);
      
      expect(result.ok).toBe(true);
      expect(result.url).toContain('/pageA');
      
      const snapshot = await client.getSnapshot(tabId);
      expect(snapshot.snapshot).toContain('Page A');
    } finally {
      await client.cleanup();
    }
  });
  
  test('navigate API accepts macro and query params directly', async () => {
    const client = createClient(serverUrl);
    
    try {
      const { tabId } = await client.createTab();
      
      // Test the raw API with macro param directly (bypass client parsing)
      // Unknown macro should fail
      await expect(
        client.request('POST', `/tabs/${tabId}/navigate`, {
          userId: client.userId,
          macro: '@fake_macro',
          query: 'test'
        })
      ).rejects.toThrow(/url or macro required/);
    } finally {
      await client.cleanup();
    }
  });
});
