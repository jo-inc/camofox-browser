import { startServer, stopServer, getServerUrl } from '../helpers/startServer.js';
import { startTestSite, stopTestSite, getTestSiteUrl } from '../helpers/testSite.js';
import { createClient } from '../helpers/client.js';

/**
 * Tests that the /tabs/:tabId/evaluate endpoint requires API key authentication
 * when CAMOFOX_API_KEY is configured, matching the security model used by the
 * cookie import endpoint.
 *
 * CVE: CWE-94 — Arbitrary JS execution without authentication
 */
describe('Evaluate endpoint authentication', () => {
  const TEST_API_KEY = 'test-secret-key-for-evaluate-auth';
  let serverUrl;
  let testSiteUrl;

  beforeAll(async () => {
    await startServer(0, { CAMOFOX_API_KEY: TEST_API_KEY });
    serverUrl = getServerUrl();
    const testPort = await startTestSite();
    testSiteUrl = getTestSiteUrl();
  }, 120000);

  afterAll(async () => {
    await stopTestSite();
    await stopServer();
  }, 30000);

  test('rejects evaluate without Bearer token when API key is configured', async () => {
    const client = createClient(serverUrl);
    try {
      const { tabId } = await client.createTab(`${testSiteUrl}/pageA`);

      // Call evaluate directly without auth header
      const res = await fetch(`${serverUrl}/tabs/${tabId}/evaluate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          userId: client.userId,
          expression: 'document.title',
        }),
      });

      expect(res.status).toBe(403);
      const data = await res.json();
      expect(data.error).toBe('Forbidden');
    } finally {
      await client.cleanup();
    }
  });

  test('rejects evaluate with wrong Bearer token', async () => {
    const client = createClient(serverUrl);
    try {
      const { tabId } = await client.createTab(`${testSiteUrl}/pageA`);

      const res = await fetch(`${serverUrl}/tabs/${tabId}/evaluate`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer wrong-key',
        },
        body: JSON.stringify({
          userId: client.userId,
          expression: 'document.title',
        }),
      });

      expect(res.status).toBe(403);
      const data = await res.json();
      expect(data.error).toBe('Forbidden');
    } finally {
      await client.cleanup();
    }
  });

  test('allows evaluate with correct Bearer token', async () => {
    const client = createClient(serverUrl);
    try {
      const { tabId } = await client.createTab(`${testSiteUrl}/pageA`);

      const res = await fetch(`${serverUrl}/tabs/${tabId}/evaluate`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${TEST_API_KEY}`,
        },
        body: JSON.stringify({
          userId: client.userId,
          expression: 'document.title',
        }),
      });

      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.ok).toBe(true);
      expect(data.result).toBe('Page A');
    } finally {
      await client.cleanup();
    }
  });
});
