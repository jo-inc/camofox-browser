const { startServer, stopServer, getServerUrl } = require('../helpers/startServer');
const { startTestSite, stopTestSite, getTestSiteUrl } = require('../helpers/testSite');
const { createClient } = require('../helpers/client');

describe('Downloads and Images', () => {
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

  test('GET /tabs/:tabId/images returns image sources', async () => {
    const client = createClient(serverUrl);

    try {
      const { tabId } = await client.createTab(`${testSiteUrl}/images-page`);
      const result = await client.getImages(tabId, { includeData: true, maxBytes: 1024 * 1024, limit: 10 });

      expect(result.images).toBeDefined();
      expect(Array.isArray(result.images)).toBe(true);
      expect(result.images.length).toBeGreaterThan(0);

      const first = result.images[0];
      expect(first.src).toMatch(/^data:image\/png;base64,/);
      expect(first.alt).toBe('Sample');
      expect(first.dataUrl).toMatch(/^data:image\/png;base64,/);
      expect(first.bytes).toBeGreaterThan(0);
    } finally {
      await client.cleanup();
    }
  });

  test('GET /tabs/:tabId/downloads captures browser downloads', async () => {
    const client = createClient(serverUrl);

    try {
      const { tabId } = await client.createTab(`${testSiteUrl}/download-page`);

      // Prefer selector click (stable for test site)
      await client.click(tabId, { selector: '#downloadLink' });

      // Poll downloads until captured
      let downloads = [];
      for (let i = 0; i < 40; i++) {
        const result = await client.getDownloads(tabId, { includeData: true, maxBytes: 1024 * 1024, consume: false });
        downloads = Array.isArray(result.downloads) ? result.downloads : [];
        if (downloads.length > 0) break;
        await new Promise((r) => setTimeout(r, 250));
      }

      expect(downloads.length).toBeGreaterThan(0);
      const first = downloads[0];
      expect(first.suggestedFilename).toBe('hello.txt');
      expect(first.bytes).toBeGreaterThan(0);
      expect(first.dataBase64).toBeDefined();
      expect(typeof first.dataBase64).toBe('string');

      // consume should clear
      const consumed = await client.getDownloads(tabId, { includeData: false, consume: true });
      expect(consumed.downloads).toBeDefined();

      const empty = await client.getDownloads(tabId, { includeData: false, consume: false });
      expect(Array.isArray(empty.downloads)).toBe(true);
      expect(empty.downloads.length).toBe(0);
    } finally {
      await client.cleanup();
    }
  });
});
