const { startServer, stopServer, getServerUrl } = require('../helpers/startServer');
const { startTestSite, stopTestSite, getTestSiteUrl } = require('../helpers/testSite');
const { createClient } = require('../helpers/client');

describe('Screenshot', () => {
  let serverUrl;
  let testSiteUrl;

  beforeAll(async () => {
    const port = await startServer(9379);
    serverUrl = getServerUrl();

    const testPort = await startTestSite();
    testSiteUrl = getTestSiteUrl();
  }, 120000);

  afterAll(async () => {
    await stopTestSite();
    await stopServer();
  }, 30000);

  test('screenshot returns raw PNG binary with correct magic bytes', async () => {
    const client = createClient(serverUrl);

    try {
      const { tabId } = await client.createTab(`${testSiteUrl}/pageA`);

      const buffer = await client.screenshot(tabId);

      expect(buffer).toBeDefined();
      expect(buffer.byteLength).toBeGreaterThan(0);

      // PNG magic bytes: 0x89 P N G
      const bytes = new Uint8Array(buffer);
      expect(bytes[0]).toBe(0x89);
      expect(bytes[1]).toBe(0x50);
      expect(bytes[2]).toBe(0x4e);
      expect(bytes[3]).toBe(0x47);
    } finally {
      await client.cleanup();
    }
  });

  test('screenshot response has image/png content type', async () => {
    const client = createClient(serverUrl);

    try {
      const { tabId } = await client.createTab(`${testSiteUrl}/pageA`);

      // Raw fetch to check headers directly
      const res = await fetch(
        `${serverUrl}/tabs/${tabId}/screenshot?userId=${client.userId}`
      );

      expect(res.ok).toBe(true);
      expect(res.headers.get('content-type')).toBe('image/png');

      const buffer = await res.arrayBuffer();
      expect(buffer.byteLength).toBeGreaterThan(0);
    } finally {
      await client.cleanup();
    }
  });

  test('screenshot response is NOT valid JSON', async () => {
    const client = createClient(serverUrl);

    try {
      const { tabId } = await client.createTab(`${testSiteUrl}/pageA`);

      const res = await fetch(
        `${serverUrl}/tabs/${tabId}/screenshot?userId=${client.userId}`
      );
      expect(res.ok).toBe(true);

      // This is the exact bug: fetchApi() called res.json() on PNG binary.
      // Verify that parsing as JSON throws.
      const text = await res.clone().text();
      expect(() => JSON.parse(text)).toThrow();
    } finally {
      await client.cleanup();
    }
  });

  test('screenshot can be base64-encoded for LLM image content blocks', async () => {
    const client = createClient(serverUrl);

    try {
      const { tabId } = await client.createTab(`${testSiteUrl}/pageA`);

      const res = await fetch(
        `${serverUrl}/tabs/${tabId}/screenshot?userId=${client.userId}`
      );
      expect(res.ok).toBe(true);

      const arrayBuffer = await res.arrayBuffer();
      const base64 = Buffer.from(arrayBuffer).toString('base64');

      // base64 should be a non-empty string
      expect(typeof base64).toBe('string');
      expect(base64.length).toBeGreaterThan(0);

      // Round-trip: decode back and verify PNG magic bytes
      const decoded = Buffer.from(base64, 'base64');
      expect(decoded[0]).toBe(0x89);
      expect(decoded[1]).toBe(0x50);
      expect(decoded[2]).toBe(0x4e);
      expect(decoded[3]).toBe(0x47);
    } finally {
      await client.cleanup();
    }
  });

  test('fullPage screenshot is larger than viewport screenshot', async () => {
    const client = createClient(serverUrl);

    try {
      // Use the scroll page which has lots of content (5000px tall)
      const { tabId } = await client.createTab(`${testSiteUrl}/scroll`);

      // Viewport screenshot
      const viewportRes = await fetch(
        `${serverUrl}/tabs/${tabId}/screenshot?userId=${client.userId}&fullPage=false`
      );
      const viewportBuf = await viewportRes.arrayBuffer();

      // Full page screenshot
      const fullPageRes = await fetch(
        `${serverUrl}/tabs/${tabId}/screenshot?userId=${client.userId}&fullPage=true`
      );
      const fullPageBuf = await fullPageRes.arrayBuffer();

      // Both should be valid PNGs
      expect(new Uint8Array(viewportBuf)[0]).toBe(0x89);
      expect(new Uint8Array(fullPageBuf)[0]).toBe(0x89);

      // Full page should be larger (more pixels to encode)
      expect(fullPageBuf.byteLength).toBeGreaterThan(viewportBuf.byteLength);
    } finally {
      await client.cleanup();
    }
  });

  test('screenshot of non-existent tab returns 404 JSON error', async () => {
    const client = createClient(serverUrl);

    try {
      const res = await fetch(
        `${serverUrl}/tabs/non-existent-tab/screenshot?userId=${client.userId}`
      );

      expect(res.status).toBe(404);
      expect(res.headers.get('content-type')).toContain('application/json');

      const data = await res.json();
      expect(data.error).toBeDefined();
    } finally {
      await client.cleanup();
    }
  });

  test('screenshot works after navigation', async () => {
    const client = createClient(serverUrl);

    try {
      const { tabId } = await client.createTab(`${testSiteUrl}/pageA`);
      await client.navigate(tabId, `${testSiteUrl}/pageB`);

      const buffer = await client.screenshot(tabId);

      expect(buffer).toBeDefined();
      expect(buffer.byteLength).toBeGreaterThan(0);

      const bytes = new Uint8Array(buffer);
      expect(bytes[0]).toBe(0x89);
    } finally {
      await client.cleanup();
    }
  });

  test('screenshot works after click interaction', async () => {
    const client = createClient(serverUrl);

    try {
      const { tabId } = await client.createTab(`${testSiteUrl}/click`);

      // Get snapshot to build refs, then click the button
      const snapshot = await client.getSnapshot(tabId);
      await client.click(tabId, { selector: '#clickMe' });

      const buffer = await client.screenshot(tabId);

      expect(buffer).toBeDefined();
      expect(buffer.byteLength).toBeGreaterThan(0);

      const bytes = new Uint8Array(buffer);
      expect(bytes[0]).toBe(0x89);
    } finally {
      await client.cleanup();
    }
  });
});
