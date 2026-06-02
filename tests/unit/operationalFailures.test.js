import { startServer, stopServer, getServerUrl } from '../helpers/startServer.js';
import { startTestSite, stopTestSite, getTestSiteUrl } from '../helpers/testSite.js';
import { createClient } from '../helpers/client.js';

describe('operational failure route responses', () => {
  let serverUrl;
  let testSiteUrl;

  beforeAll(async () => {
    await startServer();
    serverUrl = getServerUrl();
    await startTestSite();
    testSiteUrl = getTestSiteUrl();
  }, 120000);

  afterAll(async () => {
    await stopTestSite();
    await stopServer();
  }, 30000);

  test('stale refs return structured snapshot retry response', async () => {
    const client = createClient(serverUrl);
    try {
      const { tabId } = await client.createTab(`${testSiteUrl}/pageA`);
      await client.click(tabId, { ref: 'e9999' });
      throw new Error('expected stale ref to fail');
    } catch (err) {
      expect(err.status).toBe(422);
      expect(err.data.code).toBe('stale_refs');
      expect(err.data.retryable).toBe(true);
      expect(err.data.recovery).toBe('snapshot_then_retry');
    } finally {
      await client.cleanup();
    }
  });

  test('invalid selector syntax returns structured non-retryable response', async () => {
    const client = createClient(serverUrl);
    try {
      const { tabId } = await client.createTab(`${testSiteUrl}/pageA`);
      await client.type(tabId, { selector: 'text=[broken', text: 'hello' });
      throw new Error('expected invalid selector to fail');
    } catch (err) {
      expect(err.status).toBe(400);
      expect(err.data.code).toBe('invalid_selector');
      expect(err.data.retryable).toBe(false);
    } finally {
      await client.cleanup();
    }
  });
});
