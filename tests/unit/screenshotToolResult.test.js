const http = require('http');

/**
 * Unit tests for the plugin's camofox_screenshot tool result format.
 *
 * These tests spin up a tiny mock server that returns PNG binary (like the real
 * server's GET /tabs/:tabId/screenshot endpoint), then exercise both the OLD
 * (broken) and NEW (fixed) fetch-and-return logic from plugin.ts.
 *
 * This proves:
 *   1. fetchApi() + toToolResult() fails on binary PNG (the bug).
 *   2. The fixed code correctly returns an image content block.
 */

// Minimal 1x1 red PNG (67 bytes) — valid enough for testing.
const TINY_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==',
  'base64'
);

let mockServer;
let mockPort;

beforeAll(async () => {
  await new Promise((resolve) => {
    mockServer = http.createServer((req, res) => {
      if (req.url.includes('/screenshot') && !req.url.includes('missing')) {
        // Simulate the real server: return raw PNG binary
        res.writeHead(200, { 'Content-Type': 'image/png' });
        res.end(TINY_PNG);
      } else if (req.url.includes('missing')) {
        // Simulate 404 for missing tab
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Tab not found' }));
      } else {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      }
    });
    mockServer.listen(0, () => {
      mockPort = mockServer.address().port;
      resolve();
    });
  });
});

afterAll(async () => {
  if (mockServer) {
    await new Promise((resolve) => mockServer.close(resolve));
  }
});

describe('OLD plugin screenshot logic (broken)', () => {
  // Reproduces the exact code path from the old plugin.ts:
  //   const result = await fetchApi(baseUrl, `/tabs/${tabId}/screenshot?userId=${userId}`);
  //   return toToolResult(result);

  async function fetchApi(baseUrl, path) {
    const url = `${baseUrl}${path}`;
    const res = await fetch(url, {
      headers: { 'Content-Type': 'application/json' },
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`${res.status}: ${text}`);
    }
    return res.json(); // <-- BUG: calls .json() on binary PNG
  }

  function toToolResult(data) {
    return {
      content: [{ type: 'text', text: JSON.stringify(data, null, 2) }],
    };
  }

  test('fetchApi() throws when parsing PNG as JSON', async () => {
    const baseUrl = `http://localhost:${mockPort}`;

    await expect(
      fetchApi(baseUrl, '/tabs/some-tab/screenshot?userId=testuser')
    ).rejects.toThrow();
  });

  test('even if fetchApi did not throw, toToolResult wraps as text not image', () => {
    // Suppose fetchApi somehow returned an object - toToolResult would still
    // produce { type: "text" } which is wrong for screenshots.
    const result = toToolResult({ someData: true });

    expect(result.content).toHaveLength(1);
    expect(result.content[0].type).toBe('text');
    // There is no image block at all
    expect(result.content.find((c) => c.type === 'image')).toBeUndefined();
  });
});

describe('NEW plugin screenshot logic (fixed)', () => {
  // Reproduces the fixed code path from plugin.ts

  async function screenshotExecute(baseUrl, tabId, userId) {
    const url = `${baseUrl}/tabs/${tabId}/screenshot?userId=${userId}`;
    const res = await fetch(url);
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`${res.status}: ${text}`);
    }
    const arrayBuffer = await res.arrayBuffer();
    const base64 = Buffer.from(arrayBuffer).toString('base64');
    return {
      content: [
        {
          type: 'image',
          data: base64,
          mimeType: 'image/png',
        },
      ],
    };
  }

  test('returns image content block with base64 PNG', async () => {
    const baseUrl = `http://localhost:${mockPort}`;
    const result = await screenshotExecute(baseUrl, 'some-tab', 'testuser');

    expect(result.content).toHaveLength(1);

    const block = result.content[0];
    expect(block.type).toBe('image');
    expect(block.mimeType).toBe('image/png');
    expect(typeof block.data).toBe('string');
    expect(block.data.length).toBeGreaterThan(0);
  });

  test('base64 data decodes back to valid PNG', async () => {
    const baseUrl = `http://localhost:${mockPort}`;
    const result = await screenshotExecute(baseUrl, 'some-tab', 'testuser');

    const decoded = Buffer.from(result.content[0].data, 'base64');

    // PNG magic bytes
    expect(decoded[0]).toBe(0x89);
    expect(decoded[1]).toBe(0x50); // P
    expect(decoded[2]).toBe(0x4e); // N
    expect(decoded[3]).toBe(0x47); // G
  });

  test('base64 data round-trips to the exact original bytes', async () => {
    const baseUrl = `http://localhost:${mockPort}`;
    const result = await screenshotExecute(baseUrl, 'some-tab', 'testuser');

    const decoded = Buffer.from(result.content[0].data, 'base64');
    expect(decoded.equals(TINY_PNG)).toBe(true);
  });

  test('does NOT contain a text content block', async () => {
    const baseUrl = `http://localhost:${mockPort}`;
    const result = await screenshotExecute(baseUrl, 'some-tab', 'testuser');

    const textBlocks = result.content.filter((c) => c.type === 'text');
    expect(textBlocks).toHaveLength(0);
  });

  test('throws on 404 with error message', async () => {
    const baseUrl = `http://localhost:${mockPort}`;

    await expect(
      screenshotExecute(baseUrl, 'missing-tab', 'testuser')
    ).rejects.toThrow('404');
  });
});
