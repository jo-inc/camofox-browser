/**
 * Tests for BugHunter V20 network-fault endpoints.
 *
 * These tests exercise the HTTP API directly using a test server, rather than
 * requiring a live browser. Playwright calls are mocked via the tab state mock below.
 */
import { describe, test, expect, beforeAll, afterAll } from '@jest/globals';
import { startServer, stopServer, getServerUrl } from './helpers/startServer.js';

const USER = 'bughunter-nf-test';

async function openTab(serverUrl) {
  const res = await fetch(`${serverUrl}/tabs`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ userId: USER, sessionKey: 'nf-test' }),
  });
  const body = await res.json();
  return body.tabId;
}

describe('network-fault endpoints', () => {
  let serverUrl;
  let tabId;

  beforeAll(async () => {
    await startServer();
    serverUrl = getServerUrl();
    tabId = await openTab(serverUrl);
  }, 60000);

  afterAll(async () => {
    await stopServer();
  }, 15000);

  test('GET /network-fault returns null when no fault active', async () => {
    const res = await fetch(`${serverUrl}/tabs/${tabId}/network-fault?userId=${USER}`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.fault).toBeNull();
    expect(body.tabId).toBe(tabId);
  });

  test('POST /network-fault installs offline mode', async () => {
    const res = await fetch(`${serverUrl}/tabs/${tabId}/network-fault`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId: USER, mode: 'offline' }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.fault.mode).toBe('offline');
    expect(typeof body.fault.installedAtMs).toBe('number');

    // Clear for subsequent tests
    await fetch(`${serverUrl}/tabs/${tabId}/clear-network-fault`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId: USER }),
    });
  });

  test('POST /network-fault installs slow_3g mode', async () => {
    const res = await fetch(`${serverUrl}/tabs/${tabId}/network-fault`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId: USER, mode: 'slow_3g' }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.fault.mode).toBe('slow_3g');
    await fetch(`${serverUrl}/tabs/${tabId}/clear-network-fault`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId: USER }),
    });
  });

  test('POST /network-fault installs high_latency mode with latencyMs', async () => {
    const res = await fetch(`${serverUrl}/tabs/${tabId}/network-fault`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId: USER, mode: 'high_latency', latencyMs: 1500 }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.fault.mode).toBe('high_latency');
    expect(body.fault.latencyMs).toBe(1500);
    await fetch(`${serverUrl}/tabs/${tabId}/clear-network-fault`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId: USER }),
    });
  });

  test('POST /network-fault installs timeout_at_request mode', async () => {
    const res = await fetch(`${serverUrl}/tabs/${tabId}/network-fault`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId: USER, mode: 'timeout_at_request' }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.fault.mode).toBe('timeout_at_request');
    await fetch(`${serverUrl}/tabs/${tabId}/clear-network-fault`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId: USER }),
    });
  });

  test('POST /network-fault installs timeout_at_response mode', async () => {
    const res = await fetch(`${serverUrl}/tabs/${tabId}/network-fault`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId: USER, mode: 'timeout_at_response' }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.fault.mode).toBe('timeout_at_response');
    await fetch(`${serverUrl}/tabs/${tabId}/clear-network-fault`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId: USER }),
    });
  });

  test('POST /network-fault installs intermittent mode', async () => {
    const res = await fetch(`${serverUrl}/tabs/${tabId}/network-fault`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId: USER, mode: 'intermittent', percent: 50 }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.fault.mode).toBe('intermittent');
    expect(body.fault.percent).toBe(50);
    await fetch(`${serverUrl}/tabs/${tabId}/clear-network-fault`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId: USER }),
    });
  });

  test('POST /network-fault installs server_5xx mode', async () => {
    const res = await fetch(`${serverUrl}/tabs/${tabId}/network-fault`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId: USER, mode: 'server_5xx', statusCode: 503 }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.fault.mode).toBe('server_5xx');
    await fetch(`${serverUrl}/tabs/${tabId}/clear-network-fault`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId: USER }),
    });
  });

  test('POST /network-fault installs malformed_response mode', async () => {
    const res = await fetch(`${serverUrl}/tabs/${tabId}/network-fault`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId: USER, mode: 'malformed_response' }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.fault.mode).toBe('malformed_response');
    await fetch(`${serverUrl}/tabs/${tabId}/clear-network-fault`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId: USER }),
    });
  });

  test('GET /network-fault reflects installed fault', async () => {
    await fetch(`${serverUrl}/tabs/${tabId}/network-fault`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId: USER, mode: 'server_5xx', statusCode: 503 }),
    });
    const res = await fetch(`${serverUrl}/tabs/${tabId}/network-fault?userId=${USER}`);
    const body = await res.json();
    expect(body.fault.mode).toBe('server_5xx');
    await fetch(`${serverUrl}/tabs/${tabId}/clear-network-fault`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId: USER }),
    });
  });

  test('POST /network-fault 409 on double-install', async () => {
    await fetch(`${serverUrl}/tabs/${tabId}/network-fault`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId: USER, mode: 'offline' }),
    });
    const res = await fetch(`${serverUrl}/tabs/${tabId}/network-fault`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId: USER, mode: 'slow_3g' }),
    });
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.existing).toBeDefined();
    expect(body.existing.mode).toBe('offline');
    await fetch(`${serverUrl}/tabs/${tabId}/clear-network-fault`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId: USER }),
    });
  });

  test('POST /clear-network-fault is idempotent when no fault active', async () => {
    const res = await fetch(`${serverUrl}/tabs/${tabId}/clear-network-fault`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId: USER }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.cleared).toBeNull();
  });

  test('400 on invalid mode', async () => {
    const res = await fetch(`${serverUrl}/tabs/${tabId}/network-fault`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId: USER, mode: 'banana' }),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain('Invalid mode');
  });

  test('400 when high_latency missing latencyMs', async () => {
    const res = await fetch(`${serverUrl}/tabs/${tabId}/network-fault`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId: USER, mode: 'high_latency' }),
    });
    expect(res.status).toBe(400);
  });

  test('400 when intermittent missing percent', async () => {
    const res = await fetch(`${serverUrl}/tabs/${tabId}/network-fault`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId: USER, mode: 'intermittent' }),
    });
    expect(res.status).toBe(400);
  });

  test('400 when percent sent for non-intermittent mode', async () => {
    const res = await fetch(`${serverUrl}/tabs/${tabId}/network-fault`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId: USER, mode: 'offline', percent: 50 }),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain('percent not valid for mode offline');
  });

  test('400 when statusCode sent for non-server_5xx mode', async () => {
    const res = await fetch(`${serverUrl}/tabs/${tabId}/network-fault`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId: USER, mode: 'offline', statusCode: 503 }),
    });
    expect(res.status).toBe(400);
  });

  test('404 for unknown tab', async () => {
    const res = await fetch(`${serverUrl}/tabs/nonexistent-tab/network-fault`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId: USER, mode: 'offline' }),
    });
    expect(res.status).toBe(404);
  });
});
