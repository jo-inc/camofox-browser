const { startServer, stopServer, getServerUrl } = require('../helpers/startServer');
const { startTestSite, stopTestSite, getTestSiteUrl } = require('../helpers/testSite');
const { createClient } = require('../helpers/client');
const { MAX_SNAPSHOT_CHARS } = require('../../lib/snapshot');

describe('Snapshot truncation (e2e)', () => {
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

  test('small page snapshot is not truncated', async () => {
    const client = createClient(serverUrl);
    try {
      const tab = await client.createTab(`${testSiteUrl}/pageA`);
      const snap = await client.getSnapshot(tab.tabId);

      expect(snap.truncated).toBeFalsy();
      expect(snap.snapshot).toContain('Welcome to Page A');
      expect(snap.snapshot).toContain('Go to Page B');
    } finally {
      await client.cleanup();
    }
  }, 30000);

  test('large page snapshot is truncated with pagination preserved', async () => {
    const client = createClient(serverUrl);
    try {
      // 500 products — should generate a snapshot well over 80K chars
      const tab = await client.createTab(`${testSiteUrl}/large-page?count=500`);
      const snap = await client.getSnapshot(tab.tabId);

      // Should be truncated
      expect(snap.truncated).toBe(true);
      expect(snap.totalChars).toBeGreaterThan(MAX_SNAPSHOT_CHARS);

      // Should have header content (top of page)
      expect(snap.snapshot).toContain('Product Search Results');

      // Should have early products
      expect(snap.snapshot).toContain('Product 0');

      // Should have pagination links at the bottom (tail preserved)
      expect(snap.snapshot).toContain('Previous');
      expect(snap.snapshot).toContain('Next');

      // Should have truncation marker
      expect(snap.snapshot).toContain('truncated at char');

      // Should indicate more content available
      expect(snap.hasMore).toBe(true);
      expect(snap.nextOffset).toBeGreaterThan(0);

      // Output should be within size budget
      expect(snap.snapshot.length).toBeLessThanOrEqual(MAX_SNAPSHOT_CHARS + 500);
    } finally {
      await client.cleanup();
    }
  }, 60000);

  test('offset retrieves next chunk with pagination still present', async () => {
    const client = createClient(serverUrl);
    try {
      const tab = await client.createTab(`${testSiteUrl}/large-page?count=500`);
      const snap1 = await client.getSnapshot(tab.tabId);
      expect(snap1.truncated).toBe(true);
      expect(snap1.nextOffset).toBeGreaterThan(0);

      // Fetch second chunk
      const snap2 = await client.getSnapshot(tab.tabId, { offset: snap1.nextOffset });
      expect(snap2.truncated).toBe(true);

      // Second chunk should have different leading content
      const lead1 = snap1.snapshot.slice(0, 200);
      const lead2 = snap2.snapshot.slice(0, 200);
      expect(lead2).not.toBe(lead1);

      // Second chunk should still have pagination tail
      expect(snap2.snapshot).toContain('Next');
      expect(snap2.snapshot).toContain('Previous');

      // totalChars should be consistent
      expect(snap2.totalChars).toBe(snap1.totalChars);
    } finally {
      await client.cleanup();
    }
  }, 60000);

  test('navigation clears cached snapshot', async () => {
    const client = createClient(serverUrl);
    try {
      const tab = await client.createTab(`${testSiteUrl}/large-page?count=500`);
      const snap1 = await client.getSnapshot(tab.tabId);
      expect(snap1.truncated).toBe(true);
      const total1 = snap1.totalChars;

      // Navigate to a small page
      await client.navigate(tab.tabId, `${testSiteUrl}/pageA`);
      const snap2 = await client.getSnapshot(tab.tabId);

      // Should be a fresh small snapshot, not a cached chunk of the large page
      expect(snap2.truncated).toBeFalsy();
      expect(snap2.snapshot).toContain('Welcome to Page A');
      expect(snap2.snapshot).not.toContain('Product 0');
    } finally {
      await client.cleanup();
    }
  }, 60000);

  test('click clears cached snapshot', async () => {
    const client = createClient(serverUrl);
    try {
      // Navigate to large page
      const tab = await client.createTab(`${testSiteUrl}/large-page?count=500`);
      const snap1 = await client.getSnapshot(tab.tabId);
      expect(snap1.truncated).toBe(true);

      // Click "Next" pagination link — should navigate and clear cache
      // Find the Next link ref in the snapshot
      const nextMatch = snap1.snapshot.match(/link "Next" \[(e\d+)\]/);
      if (nextMatch) {
        await client.click(tab.tabId, { ref: nextMatch[1] });
        const snap2 = await client.getSnapshot(tab.tabId);
        // Should be a fresh snapshot (page=2), not a cached chunk of page 1
        expect(snap2.url).toContain('page=2');
      }
    } finally {
      await client.cleanup();
    }
  }, 60000);

  test('iterating chunks covers products from start to end', async () => {
    const client = createClient(serverUrl);
    try {
      const tab = await client.createTab(`${testSiteUrl}/large-page?count=500`);

      let offset = 0;
      let seenProducts = new Set();
      let chunks = 0;

      while (true) {
        const snap = await client.getSnapshot(tab.tabId, offset > 0 ? { offset } : {});
        chunks++;

        // Extract product numbers
        const matches = snap.snapshot.matchAll(/Product (\d+) -/g);
        for (const m of matches) seenProducts.add(parseInt(m[1]));

        if (!snap.hasMore) break;
        offset = snap.nextOffset;
        if (chunks > 20) throw new Error('too many chunks');
      }

      expect(chunks).toBeGreaterThan(1);
      // Should see first and last products
      expect(seenProducts.has(0)).toBe(true);
      expect(seenProducts.has(499)).toBe(true);
    } finally {
      await client.cleanup();
    }
  }, 120000);
});
