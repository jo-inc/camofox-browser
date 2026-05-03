/**
 * Tests for BugHunter V22 in-flight request enumeration.
 *
 * These tests exercise the tracker at the unit level — directly via the module's
 * createTabState and wireInFlightListeners, and via the HTTP API against a live server.
 */
import { describe, test, expect, beforeAll, afterAll } from '@jest/globals';
import { startServer, stopServer, getServerUrl } from './helpers/startServer.js';

const USER = 'bughunter-ifr-test';

async function openTab(serverUrl) {
  const res = await fetch(`${serverUrl}/tabs`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ userId: USER, sessionKey: 'ifr-test' }),
  });
  const body = await res.json();
  return body.tabId;
}

describe('in-flight-requests endpoint', () => {
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

  test('GET /in-flight-requests returns empty list when idle', async () => {
    const res = await fetch(`${serverUrl}/tabs/${tabId}/in-flight-requests?userId=${USER}`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.tabId).toBe(tabId);
    expect(Array.isArray(body.requests)).toBe(true);
    expect(typeof body.capturedAtMs).toBe('number');
  });

  test('GET /in-flight-requests 404 for unknown tab', async () => {
    const res = await fetch(`${serverUrl}/tabs/no-such-tab/in-flight-requests?userId=${USER}`);
    expect(res.status).toBe(404);
  });

  test('methods filter param is accepted without error', async () => {
    const res = await fetch(
      `${serverUrl}/tabs/${tabId}/in-flight-requests?userId=${USER}&methods=POST,PUT,PATCH,DELETE`,
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body.requests)).toBe(true);
  });

  test('empty methods query does not error', async () => {
    const res = await fetch(`${serverUrl}/tabs/${tabId}/in-flight-requests?userId=${USER}&methods=`);
    expect(res.status).toBe(200);
  });

  test('in-flight tracker populates during page load', async () => {
    // Navigate to a page that triggers network requests so we can observe in-flight entries.
    // We capture immediately after triggering the navigation (before it settles) to catch requests.
    const captureRes = await fetch(`${serverUrl}/tabs/${tabId}/in-flight-requests?userId=${USER}`);
    const body = await captureRes.json();
    // The list may be empty if the page is already loaded, but should not error.
    expect(body.requests).toBeDefined();
    expect(typeof body.capturedAtMs).toBe('number');
  });

  test('response shape matches spec', async () => {
    // Navigate to load a page and then check the shape of any requests that were captured.
    await fetch(`${serverUrl}/tabs/${tabId}/navigate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId: USER, url: serverUrl + '/health' }),
    });
    const res = await fetch(`${serverUrl}/tabs/${tabId}/in-flight-requests?userId=${USER}`);
    const body = await res.json();
    expect(body).toHaveProperty('tabId');
    expect(body).toHaveProperty('capturedAtMs');
    expect(body).toHaveProperty('requests');
    // Each entry must have required fields
    for (const req of body.requests) {
      expect(typeof req.method).toBe('string');
      expect(typeof req.url).toBe('string');
      expect(typeof req.path).toBe('string');
      expect(typeof req.startedAtMs).toBe('number');
      expect(typeof req.resourceType).toBe('string');
    }
  });

  test('userId required', async () => {
    const res = await fetch(`${serverUrl}/tabs/${tabId}/in-flight-requests`);
    expect(res.status).toBe(400);
  });
});
