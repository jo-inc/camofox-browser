/**
 * Tests for BugHunter V23 timezone endpoints.
 */
import { describe, test, expect, beforeAll, afterAll } from '@jest/globals';
import { startServer, stopServer, getServerUrl } from './helpers/startServer.js';

const USER = 'bughunter-tz-test';

async function openTab(serverUrl) {
  const res = await fetch(`${serverUrl}/tabs`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ userId: USER, sessionKey: 'tz-test' }),
  });
  const body = await res.json();
  return body.tabId;
}

describe('timezone endpoints', () => {
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

  test('POST /timezone installs polyfill and returns reloadRequired: true', async () => {
    const res = await fetch(`${serverUrl}/tabs/${tabId}/timezone`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId: USER, id: 'America/New_York' }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.timezoneId).toBe('America/New_York');
    expect(body.appliedVia).toBe('init-script');
    expect(body.reloadRequired).toBe(true);

    await fetch(`${serverUrl}/tabs/${tabId}/clear-timezone`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId: USER }),
    });
  });

  test('POST /timezone + reload makes page see new timezone', async () => {
    await fetch(`${serverUrl}/tabs/${tabId}/timezone`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId: USER, id: 'Asia/Tokyo' }),
    });
    // Navigate to apply init-script. Use the server's /health as a valid http:// URL.
    await fetch(`${serverUrl}/tabs/${tabId}/navigate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId: USER, url: serverUrl + '/health' }),
    });
    // Verify getTimezoneOffset returns -540 (JST = UTC+9, getTimezoneOffset returns utc - local)
    const evalRes = await fetch(`${serverUrl}/tabs/${tabId}/evaluate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId: USER, expression: 'new Date(0).getTimezoneOffset()' }),
    });
    const evalBody = await evalRes.json();
    // JST is UTC+9, so getTimezoneOffset should be -540
    expect(evalBody.result).toBe(-540);

    await fetch(`${serverUrl}/tabs/${tabId}/clear-timezone`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId: USER }),
    });
  });

  test('DST: America/New_York offset is 300 (EST) before spring forward, 240 (EDT) after', async () => {
    await fetch(`${serverUrl}/tabs/${tabId}/timezone`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId: USER, id: 'America/New_York' }),
    });
    await fetch(`${serverUrl}/tabs/${tabId}/navigate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId: USER, url: serverUrl + '/health' }),
    });

    // 2027-03-14T06:59:59Z = 1 second before DST begins in Eastern Time (2am local → 3am).
    // Using 2027 (not 2024) because the polyfill offset table covers ±2 years from now (2026).
    const beforeRes = await fetch(`${serverUrl}/tabs/${tabId}/evaluate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId: USER, expression: 'new Date("2027-03-14T06:59:59Z").getTimezoneOffset()' }),
    });
    const beforeBody = await beforeRes.json();
    expect(beforeBody.result).toBe(300); // EST: UTC-5 → getTimezoneOffset = 300

    // 2027-03-14T07:00:01Z = 1 second after DST begins
    const afterRes = await fetch(`${serverUrl}/tabs/${tabId}/evaluate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId: USER, expression: 'new Date("2027-03-14T07:00:01Z").getTimezoneOffset()' }),
    });
    const afterBody = await afterRes.json();
    expect(afterBody.result).toBe(240); // EDT: UTC-4 → getTimezoneOffset = 240

    await fetch(`${serverUrl}/tabs/${tabId}/clear-timezone`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId: USER }),
    });
  });

  test('POST /clear-timezone clears active polyfill', async () => {
    await fetch(`${serverUrl}/tabs/${tabId}/timezone`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId: USER, id: 'Europe/London' }),
    });
    const clearRes = await fetch(`${serverUrl}/tabs/${tabId}/clear-timezone`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId: USER }),
    });
    expect(clearRes.status).toBe(200);
    const clearBody = await clearRes.json();
    expect(clearBody.cleared).toBe(true);
    expect(clearBody.reloadRequired).toBe(true);
  });

  test('POST /clear-timezone is idempotent when no timezone set', async () => {
    const res = await fetch(`${serverUrl}/tabs/${tabId}/clear-timezone`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId: USER }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.cleared).toBe(false);
    expect(body.reloadRequired).toBe(false);
  });

  test('double-set timezone replaces prior polyfill (single-zone invariant)', async () => {
    await fetch(`${serverUrl}/tabs/${tabId}/timezone`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId: USER, id: 'America/Los_Angeles' }),
    });
    const secondRes = await fetch(`${serverUrl}/tabs/${tabId}/timezone`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId: USER, id: 'Asia/Tokyo' }),
    });
    expect(secondRes.status).toBe(200);
    const body = await secondRes.json();
    expect(body.timezoneId).toBe('Asia/Tokyo');

    await fetch(`${serverUrl}/tabs/${tabId}/clear-timezone`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId: USER }),
    });
  });

  test('400 on invalid IANA format', async () => {
    const res = await fetch(`${serverUrl}/tabs/${tabId}/timezone`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId: USER, id: '' }),
    });
    expect(res.status).toBe(400);
  });

  test('400 on missing id', async () => {
    const res = await fetch(`${serverUrl}/tabs/${tabId}/timezone`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId: USER }),
    });
    expect(res.status).toBe(400);
  });

  test('404 for unknown tab', async () => {
    const res = await fetch(`${serverUrl}/tabs/no-such-tab/timezone`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId: USER, id: 'UTC' }),
    });
    expect(res.status).toBe(404);
  });
});
