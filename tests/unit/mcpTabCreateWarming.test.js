/**
 * A POST /tabs that outlives the server's tab-create deadline while the browser or a big saved profile is still
 * warming up answers 503 { code: 'tab_create_warming', retryable: true } with Retry-After. The shared transport
 * retries it, so an agent gets the tab (or a final error), not a warming error it has to retry itself.
 */
import http from 'node:http';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, jest, test } from '@jest/globals';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

import { runTool, fetchSpec, buildRequest } from '../../lib/mcp-tool-contracts.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

const CTX = { userId: 'u1', sessionKey: 'default' };
const CONFIG = { apiKey: '', accessKey: '', cookiesDir: '/tmp/cookies', port: 9377 };
const WARMING = { error: 'Browser is warming up, retry shortly', code: 'tab_create_warming', retryable: true, recovery: 'retry' };
const open = [];

afterEach(async () => {
  while (open.length) await open.pop()();
});

// A camofox REST server whose POST /tabs is warming for its first N calls (every call for Infinity).
async function fakeCamofox({ warming, retryAfter = '5', status = 503, body = WARMING }) {
  const calls = [];
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', () => {
      calls.push({ method: req.method, path: req.url, body: raw ? JSON.parse(raw) : null });
      if (req.method === 'POST' && req.url === '/tabs' && calls.length <= warming) {
        res.writeHead(status, { 'content-type': 'application/json', ...(retryAfter === null ? {} : { 'retry-after': retryAfter }) });
        res.end(JSON.stringify(body));
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ tabId: 'tab-1', url: 'https://example.com/', httpStatus: 200, navigationOk: true }));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  open.push(() => new Promise((resolve) => server.close(resolve)));
  return { baseUrl: 'http://127.0.0.1:' + server.address().port, calls };
}

// Waits that take no time: the clock moves only when the transport sleeps.
function fakeClock() {
  let now = 0;
  return {
    sleep: jest.fn(async (ms) => { now += ms; }),
    now: () => now,
    log: jest.fn(),
  };
}

describe('tab create while the browser is warming up', () => {
  test('camofox_create_tab retries a warming 503 until the tab exists, one log line per retry', async () => {
    const camofox = await fakeCamofox({ warming: 2 });
    const clock = fakeClock();
    const { payload } = await runTool('camofox_create_tab', { url: 'https://example.com' }, CTX, camofox.baseUrl, CONFIG, clock);

    expect(payload.tabId).toBe('tab-1');
    expect(camofox.calls.map((c) => c.method + ' ' + c.path)).toEqual(['POST /tabs', 'POST /tabs', 'POST /tabs']);
    // The same request each time.
    expect(new Set(camofox.calls.map((c) => JSON.stringify(c.body))).size).toBe(1);
    expect(clock.sleep.mock.calls).toEqual([[5000], [5000]]);
    expect(clock.log).toHaveBeenCalledTimes(2);
    for (const [line] of clock.log.mock.calls) {
      expect(line).not.toContain('\n');
      expect(line).toMatch(/POST \/tabs.*tab_create_warming.*retry \d+ in 5 s/);
    }
  });

  test('honours Retry-After, and waits 5 s when it is missing', async () => {
    const short = await fakeCamofox({ warming: 1, retryAfter: '2' });
    const a = fakeClock();
    await runTool('camofox_create_tab', { url: 'https://example.com' }, CTX, short.baseUrl, CONFIG, a);
    expect(a.sleep.mock.calls).toEqual([[2000]]);

    const none = await fakeCamofox({ warming: 1, retryAfter: null });
    const b = fakeClock();
    await runTool('camofox_create_tab', { url: 'https://example.com' }, CTX, none.baseUrl, CONFIG, b);
    expect(b.sleep.mock.calls).toEqual([[5000]]);
  });

  test('gives up after about 90 s with a final error that says so', async () => {
    const camofox = await fakeCamofox({ warming: Infinity });
    const clock = fakeClock();
    await expect(runTool('camofox_create_tab', { url: 'https://example.com' }, CTX, camofox.baseUrl, CONFIG, clock))
      .rejects.toThrow(/^503: .*tab_create_warming.*\(still warming up after 18 retries over 90 s\)$/s);
    expect(clock.now()).toBe(90000);
    expect(camofox.calls).toHaveLength(19);
  });

  test('a 503 that is not a warming tab create is not retried', async () => {
    const camofox = await fakeCamofox({ warming: 1, body: { error: 'Maximum concurrent sessions reached', code: 'admission_rejected' } });
    const clock = fakeClock();
    await expect(runTool('camofox_create_tab', { url: 'https://example.com' }, CTX, camofox.baseUrl, CONFIG, clock))
      .rejects.toThrow(/^503: .*admission_rejected/);
    expect(camofox.calls).toHaveLength(1);
    expect(clock.sleep).not.toHaveBeenCalled();
  });

  test('the retry lives in the shared transport, so every tool and host that creates a tab gets it', async () => {
    const camofox = await fakeCamofox({ warming: 1 });
    const clock = fakeClock();
    const out = await fetchSpec(camofox.baseUrl, buildRequest('camofox_create_tab', { url: 'https://example.com' }, CTX), CONFIG, clock);
    expect(out.tabId).toBe('tab-1');
    expect(clock.sleep).toHaveBeenCalledTimes(1);
  });

  test('over MCP, the agent gets the tab, not the warming error', async () => {
    const camofox = await fakeCamofox({ warming: 1, retryAfter: '0' });
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [join(ROOT, 'mcp', 'server.mjs')],
      cwd: ROOT,
      env: { PATH: process.env.PATH, HOME: process.env.HOME, CAMOFOX_BASE_URL: camofox.baseUrl, CAMOFOX_USER_ID: CTX.userId },
      stderr: 'pipe',
    });
    let stderr = '';
    transport.stderr.on('data', (chunk) => { stderr += chunk; });
    const client = new Client({ name: 'warming-test', version: '0' });
    await client.connect(transport);
    open.push(() => client.close());
    const result = await client.callTool({ name: 'camofox_create_tab', arguments: { url: 'https://example.com' } });
    expect(result.isError).toBeFalsy();
    expect(JSON.parse(result.content[0].text).tabId).toBe('tab-1');
    expect(camofox.calls).toHaveLength(2);
    expect(stderr.split('\n').filter((line) => line.includes('tab_create_warming'))).toHaveLength(1);
  });
});
