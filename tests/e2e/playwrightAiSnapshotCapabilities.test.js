import { launchOptions } from 'camoufox-js';
import { firefox } from 'playwright-core';

describe('Playwright AI ariaSnapshot capability', () => {
  test('page.ariaSnapshot({ mode: "ai" }) exposes ref annotations', async () => {
    const options = await launchOptions({
      headless: true,
      humanize: false,
      enable_cache: false,
    });
    const browser = await firefox.launch(options);
    try {
      const page = await browser.newPage();
      await page.setContent(`
        <!DOCTYPE html>
        <main>
          <h1>AI Snapshot Capability</h1>
          <button>Click me</button>
          <a href="/docs">Docs</a>
        </main>
      `);

      expect(typeof page.ariaSnapshot).toBe('function');
      const normal = await page.locator('body').ariaSnapshot({ timeout: 5000 });
      const ai = await page.ariaSnapshot({ mode: 'ai', timeout: 5000 });

      expect(normal).toContain('AI Snapshot Capability');
      expect(normal).not.toMatch(/\[ref=e\d+\]/);
      expect(ai).toContain('AI Snapshot Capability');
      expect(ai).toMatch(/\[ref=e\d+\]/);
      expect(ai).toMatch(/button "Click me" \[ref=e\d+\]/);
      expect(ai).toMatch(/link "Docs" \[ref=e\d+\]/);
    } finally {
      await browser.close().catch(() => {});
    }
  }, 60000);
});
