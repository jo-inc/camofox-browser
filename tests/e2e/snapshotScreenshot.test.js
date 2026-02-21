const { startServer, stopServer, getServerUrl } = require('../helpers/startServer');
const { startTestSite, stopTestSite, getTestSiteUrl } = require('../helpers/testSite');
const { createClient } = require('../helpers/client');
const { PNG } = require('pngjs');

describe('Snapshot with includeScreenshot', () => {
  let serverUrl;
  let testSiteUrl;

  beforeAll(async () => {
    await startServer(9381);
    serverUrl = getServerUrl();

    await startTestSite();
    testSiteUrl = getTestSiteUrl();
  }, 120000);

  afterAll(async () => {
    await stopTestSite();
    await stopServer();
  }, 30000);

  test('snapshot without includeScreenshot has no screenshot field', async () => {
    const client = createClient(serverUrl);

    try {
      const { tabId } = await client.createTab(`${testSiteUrl}/pageA`);
      const snapshot = await client.getSnapshot(tabId);

      expect(snapshot.url).toContain('/pageA');
      expect(snapshot.snapshot).toBeDefined();
      expect(snapshot.refsCount).toBeDefined();
      expect(snapshot.screenshot).toBeUndefined();
    } finally {
      await client.cleanup();
    }
  });

  test('snapshot with includeScreenshot returns screenshot object', async () => {
    const client = createClient(serverUrl);

    try {
      const { tabId } = await client.createTab(`${testSiteUrl}/pageA`);
      const snapshot = await client.getSnapshot(tabId, { includeScreenshot: true });

      expect(snapshot.url).toContain('/pageA');
      expect(snapshot.snapshot).toBeDefined();
      expect(snapshot.refsCount).toBeDefined();

      // Screenshot should be present with base64 data and mimeType
      expect(snapshot.screenshot).toBeDefined();
      expect(snapshot.screenshot.mimeType).toBe('image/png');
      expect(typeof snapshot.screenshot.data).toBe('string');
      expect(snapshot.screenshot.data.length).toBeGreaterThan(0);
    } finally {
      await client.cleanup();
    }
  });

  test('screenshot data is valid base64-encoded PNG', async () => {
    const client = createClient(serverUrl);

    try {
      const { tabId } = await client.createTab(`${testSiteUrl}/pageA`);
      const snapshot = await client.getSnapshot(tabId, { includeScreenshot: true });

      const decoded = Buffer.from(snapshot.screenshot.data, 'base64');

      // PNG magic bytes: 0x89 P N G
      expect(decoded[0]).toBe(0x89);
      expect(decoded[1]).toBe(0x50);
      expect(decoded[2]).toBe(0x4e);
      expect(decoded[3]).toBe(0x47);
    } finally {
      await client.cleanup();
    }
  });

  test('snapshot ARIA tree is identical with and without screenshot', async () => {
    const client = createClient(serverUrl);

    try {
      const { tabId } = await client.createTab(`${testSiteUrl}/pageA`);

      const withoutScreenshot = await client.getSnapshot(tabId);
      const withScreenshot = await client.getSnapshot(tabId, { includeScreenshot: true });

      expect(withScreenshot.snapshot).toBe(withoutScreenshot.snapshot);
      expect(withScreenshot.refsCount).toBe(withoutScreenshot.refsCount);
      expect(withScreenshot.url).toBe(withoutScreenshot.url);
    } finally {
      await client.cleanup();
    }
  });

  test('includeScreenshot works on /snapshot (OpenClaw format)', async () => {
    const client = createClient(serverUrl);

    try {
      const { tabId } = await client.createTab(`${testSiteUrl}/pageA`);

      // Use the /snapshot endpoint directly (OpenClaw format)
      const res = await fetch(
        `${serverUrl}/snapshot?userId=${client.userId}&targetId=${tabId}&includeScreenshot=true`
      );
      expect(res.ok).toBe(true);

      const data = await res.json();
      expect(data.ok).toBe(true);
      expect(data.format).toBe('aria');
      expect(data.snapshot).toBeDefined();

      // Screenshot present
      expect(data.screenshot).toBeDefined();
      expect(data.screenshot.mimeType).toBe('image/png');
      expect(data.screenshot.data.length).toBeGreaterThan(0);

      // Decode and verify PNG
      const decoded = Buffer.from(data.screenshot.data, 'base64');
      expect(decoded[0]).toBe(0x89);
    } finally {
      await client.cleanup();
    }
  });

  test('screenshot works after navigation', async () => {
    const client = createClient(serverUrl);

    try {
      const { tabId } = await client.createTab(`${testSiteUrl}/pageA`);
      await client.navigate(tabId, `${testSiteUrl}/pageB`);

      const snapshot = await client.getSnapshot(tabId, { includeScreenshot: true });

      expect(snapshot.url).toContain('/pageB');
      expect(snapshot.screenshot).toBeDefined();
      expect(snapshot.screenshot.data.length).toBeGreaterThan(0);
    } finally {
      await client.cleanup();
    }
  });

  test('screenshot captures actual page content (red pixels from red box)', async () => {
    const client = createClient(serverUrl);

    try {
      const { tabId } = await client.createTab(`${testSiteUrl}/redbox`);
      const snapshot = await client.getSnapshot(tabId, { includeScreenshot: true });

      const pngBuffer = Buffer.from(snapshot.screenshot.data, 'base64');
      const png = PNG.sync.read(pngBuffer);

      // Image should have real dimensions
      expect(png.width).toBeGreaterThan(0);
      expect(png.height).toBeGreaterThan(0);

      // Count red pixels (R=255, G=0, B=0) — the 200x200 red box should produce many
      let redPixels = 0;
      for (let i = 0; i < png.data.length; i += 4) {
        const r = png.data[i];
        const g = png.data[i + 1];
        const b = png.data[i + 2];
        if (r === 255 && g === 0 && b === 0) {
          redPixels++;
        }
      }

      // 200x200 box = 40,000 red pixels expected, allow some tolerance for anti-aliasing
      expect(redPixels).toBeGreaterThan(30000);
    } finally {
      await client.cleanup();
    }
  });

  test('screenshot of white page has no red pixels (control test)', async () => {
    const client = createClient(serverUrl);

    try {
      const { tabId } = await client.createTab(`${testSiteUrl}/pageA`);
      const snapshot = await client.getSnapshot(tabId, { includeScreenshot: true });

      const pngBuffer = Buffer.from(snapshot.screenshot.data, 'base64');
      const png = PNG.sync.read(pngBuffer);

      let redPixels = 0;
      for (let i = 0; i < png.data.length; i += 4) {
        const r = png.data[i];
        const g = png.data[i + 1];
        const b = png.data[i + 2];
        if (r === 255 && g === 0 && b === 0) {
          redPixels++;
        }
      }

      // A normal text page should have zero or near-zero pure red pixels
      expect(redPixels).toBeLessThan(100);
    } finally {
      await client.cleanup();
    }
  });

  test('non-existent tab returns 404 even with includeScreenshot', async () => {
    const client = createClient(serverUrl);

    try {
      await expect(
        client.getSnapshot('non-existent-tab', { includeScreenshot: true })
      ).rejects.toMatchObject({ status: 404 });
    } finally {
      await client.cleanup();
    }
  });
});
