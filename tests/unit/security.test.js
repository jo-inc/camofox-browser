const { startServer, stopServer, getServerUrl } = require('../helpers/startServer');
const { startTestSite, stopTestSite, getTestSiteUrl } = require('../helpers/testSite');
const { createClient } = require('../helpers/client');

describe('Security', () => {
  let serverUrl;
  let testSiteUrl;

  beforeAll(async () => {
    await startServer();
    serverUrl = getServerUrl();
    const testPort = await startTestSite();
    testSiteUrl = getTestSiteUrl();
  }, 120000);

  afterAll(async () => {
    await stopTestSite();
    await stopServer();
  }, 30000);

  describe('URL scheme validation', () => {
    test('blocks file:// URLs on tab creation', async () => {
      const client = createClient(serverUrl);
      try {
        await client.createTab('file:///etc/passwd');
        fail('Should have rejected file:// URL');
      } catch (err) {
        expect(err.status).toBe(400);
        expect(err.data.error).toContain('Blocked URL scheme');
      } finally {
        await client.cleanup();
      }
    });

    test('blocks javascript: URLs on tab creation', async () => {
      const client = createClient(serverUrl);
      try {
        await client.createTab('javascript:alert(1)');
        fail('Should have rejected javascript: URL');
      } catch (err) {
        expect(err.status).toBe(400);
        expect(err.data.error).toContain('Blocked URL scheme');
      } finally {
        await client.cleanup();
      }
    });

    test('blocks data: URLs on tab creation', async () => {
      const client = createClient(serverUrl);
      try {
        await client.createTab('data:text/html,<h1>hello</h1>');
        fail('Should have rejected data: URL');
      } catch (err) {
        expect(err.status).toBe(400);
        expect(err.data.error).toContain('Blocked URL scheme');
      } finally {
        await client.cleanup();
      }
    });

    test('blocks file:// URLs on navigate', async () => {
      const client = createClient(serverUrl);
      try {
        const { tabId } = await client.createTab(`${testSiteUrl}/pageA`);
        await client.navigate(tabId, 'file:///etc/shadow');
        fail('Should have rejected file:// URL');
      } catch (err) {
        expect(err.status).toBe(400);
        expect(err.data.error).toContain('Blocked URL scheme');
      } finally {
        await client.cleanup();
      }
    });

    test('allows http:// URLs', async () => {
      const client = createClient(serverUrl);
      try {
        const result = await client.createTab(`${testSiteUrl}/pageA`);
        expect(result.tabId).toBeDefined();
      } finally {
        await client.cleanup();
      }
    });

    test('allows https:// URLs', async () => {
      const client = createClient(serverUrl);
      try {
        // This will fail to connect but should not be blocked by scheme validation
        await client.createTab('https://localhost:99999/nope');
      } catch (err) {
        // Connection error is fine — the point is it wasn't a 400 scheme block
        expect(err.data?.error || '').not.toContain('Blocked URL scheme');
      } finally {
        await client.cleanup();
      }
    });

    test('rejects invalid URLs', async () => {
      const client = createClient(serverUrl);
      try {
        await client.createTab('not-a-url');
        fail('Should have rejected invalid URL');
      } catch (err) {
        expect(err.status).toBe(400);
        expect(err.data.error).toContain('Invalid URL');
      } finally {
        await client.cleanup();
      }
    });
  });

  describe('Resource limits', () => {
    test('enforces max tabs per session', async () => {
      const client = createClient(serverUrl);
      const tabs = [];
      try {
        for (let i = 0; i < 10; i++) {
          const result = await client.createTab(`${testSiteUrl}/pageA`);
          tabs.push(result.tabId);
        }
        // 11th tab should be rejected
        await client.createTab(`${testSiteUrl}/pageA`);
        fail('Should have rejected 11th tab');
      } catch (err) {
        expect(err.status).toBe(429);
        expect(err.data.error).toContain('Maximum tabs');
      } finally {
        await client.cleanup();
      }
    }, 120000);

    test('can create tabs after closing some', async () => {
      const client = createClient(serverUrl);
      try {
        const tabs = [];
        for (let i = 0; i < 10; i++) {
          const result = await client.createTab(`${testSiteUrl}/pageA`);
          tabs.push(result.tabId);
        }
        // Close one
        await client.closeTab(tabs[0]);
        // Should now be able to create another
        const result = await client.createTab(`${testSiteUrl}/pageA`);
        expect(result.tabId).toBeDefined();
      } finally {
        await client.cleanup();
      }
    }, 120000);
  });

  describe('Health endpoint info disclosure', () => {
    test('health does not expose session count', async () => {
      const res = await fetch(`${serverUrl}/health`);
      const data = await res.json();
      expect(data.sessions).toBeUndefined();
      expect(data.ok).toBe(true);
      expect(data.engine).toBe('camoufox');
    });

    test('root does not expose session count', async () => {
      const res = await fetch(`${serverUrl}/`);
      const data = await res.json();
      expect(data.sessions).toBeUndefined();
    });
  });

  describe('POST /stop requires admin key', () => {
    test('rejects stop without admin key', async () => {
      const res = await fetch(`${serverUrl}/stop`, { method: 'POST' });
      expect(res.status).toBe(403);
      const data = await res.json();
      expect(data.error).toBe('Forbidden');
    });

    test('rejects stop with wrong admin key', async () => {
      const res = await fetch(`${serverUrl}/stop`, {
        method: 'POST',
        headers: { 'x-admin-key': 'wrong-key' },
      });
      expect(res.status).toBe(403);
    });
  });

  describe('OpenClaw endpoints require userId', () => {
    test('POST /tabs/open rejects without userId', async () => {
      const res = await fetch(`${serverUrl}/tabs/open`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: `${testSiteUrl}/pageA` }),
      });
      expect(res.status).toBe(400);
      const data = await res.json();
      expect(data.error).toContain('userId');
    });

    test('POST /navigate rejects without userId', async () => {
      const res = await fetch(`${serverUrl}/navigate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ targetId: 'fake', url: `${testSiteUrl}/pageA` }),
      });
      expect(res.status).toBe(400);
      const data = await res.json();
      expect(data.error).toContain('userId');
    });

    test('GET /snapshot rejects without userId', async () => {
      const res = await fetch(`${serverUrl}/snapshot?targetId=fake`);
      expect(res.status).toBe(400);
      const data = await res.json();
      expect(data.error).toContain('userId');
    });

    test('POST /act rejects without userId', async () => {
      const res = await fetch(`${serverUrl}/act`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ kind: 'click', targetId: 'fake', ref: 'e1' }),
      });
      expect(res.status).toBe(400);
      const data = await res.json();
      expect(data.error).toContain('userId');
    });
  });

  describe('Session isolation', () => {
    test('users cannot access each other tabs', async () => {
      const client1 = createClient(serverUrl);
      const client2 = createClient(serverUrl);
      try {
        const { tabId } = await client1.createTab(`${testSiteUrl}/pageA`);

        // client2 trying to snapshot client1's tab should 404
        try {
          await client2.getSnapshot(tabId);
          fail('Should not be able to access another user tab');
        } catch (err) {
          expect(err.status).toBe(404);
        }
      } finally {
        await client1.cleanup();
        await client2.cleanup();
      }
    });
  });

  describe('JSON body size limit', () => {
    test('rejects oversized request bodies', async () => {
      const largeBody = JSON.stringify({ data: 'x'.repeat(200000) });
      const res = await fetch(`${serverUrl}/tabs`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: largeBody,
      });
      expect(res.status).toBe(413);
    });
  });
});
