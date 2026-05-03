/**
 * Tests for BugHunter V23 init-script endpoints.
 */
import { describe, test, expect, beforeAll, afterAll } from '@jest/globals';
import { startServer, stopServer, getServerUrl } from './helpers/startServer.js';

const USER = 'bughunter-is-test';

async function openTab(serverUrl) {
  const res = await fetch(`${serverUrl}/tabs`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ userId: USER, sessionKey: 'is-test' }),
  });
  const body = await res.json();
  return body.tabId;
}

describe('init-script endpoints', () => {
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

  test('POST /init-script registers script and returns id', async () => {
    const res = await fetch(`${serverUrl}/tabs/${tabId}/init-script`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId: USER, script: 'window.__TEST_VAR = 42;' }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(typeof body.id).toBe('string');
    expect(body.id.length).toBeGreaterThan(0);
    expect(body.scriptLength).toBe('window.__TEST_VAR = 42;'.length);
    expect(body).not.toHaveProperty('script'); // must not echo body
    expect(typeof body.installedAtMs).toBe('number');

    await fetch(`${serverUrl}/tabs/${tabId}/clear-init-scripts`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId: USER }),
    });
  });

  test('POST /init-script accepts caller-supplied id', async () => {
    const res = await fetch(`${serverUrl}/tabs/${tabId}/init-script`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId: USER, script: 'window.__ID_TEST = true;', id: 'my-custom-id' }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.id).toBe('my-custom-id');

    await fetch(`${serverUrl}/tabs/${tabId}/clear-init-scripts`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId: USER }),
    });
  });

  test('POST /init-script 409 on duplicate caller-supplied id', async () => {
    await fetch(`${serverUrl}/tabs/${tabId}/init-script`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId: USER, script: 'window.__A = 1;', id: 'dup-id' }),
    });
    const res = await fetch(`${serverUrl}/tabs/${tabId}/init-script`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId: USER, script: 'window.__B = 2;', id: 'dup-id' }),
    });
    expect(res.status).toBe(409);
    await fetch(`${serverUrl}/tabs/${tabId}/clear-init-scripts`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId: USER }),
    });
  });

  test('POST /init-script 413 on script > 256 KB', async () => {
    const bigScript = 'x'.repeat(262145);
    const res = await fetch(`${serverUrl}/tabs/${tabId}/init-script`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId: USER, script: bigScript }),
    });
    // Either 413 from express body parser or our own check
    expect([400, 413]).toContain(res.status);
  });

  test('POST /init-script 400 on empty script', async () => {
    const res = await fetch(`${serverUrl}/tabs/${tabId}/init-script`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId: USER, script: '' }),
    });
    expect(res.status).toBe(400);
  });

  test('POST /clear-init-scripts disposes all scripts', async () => {
    // Install two scripts
    await fetch(`${serverUrl}/tabs/${tabId}/init-script`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId: USER, script: 'window.__X = 1;' }),
    });
    await fetch(`${serverUrl}/tabs/${tabId}/init-script`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId: USER, script: 'window.__Y = 2;' }),
    });

    const clearRes = await fetch(`${serverUrl}/tabs/${tabId}/clear-init-scripts`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId: USER }),
    });
    expect(clearRes.status).toBe(200);
    const clearBody = await clearRes.json();
    expect(clearBody.ok).toBe(true);
    expect(clearBody.cleared).toBe(2);
    expect(clearBody.reloadRequired).toBe(true);
  });

  test('POST /clear-init-scripts is idempotent when empty', async () => {
    const res = await fetch(`${serverUrl}/tabs/${tabId}/clear-init-scripts`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId: USER }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.cleared).toBe(0);
    expect(body.reloadRequired).toBe(false);
  });

  test('init-script + navigate + evaluate confirms script ran', async () => {
    await fetch(`${serverUrl}/tabs/${tabId}/init-script`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId: USER, script: 'window.__ZONE = "injected";' }),
    });
    // Navigate to load new document (init script runs on next document).
    // Use the camofox server's own /health endpoint as a valid http:// URL.
    await fetch(`${serverUrl}/tabs/${tabId}/navigate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId: USER, url: serverUrl + '/health' }),
    });
    const evalRes = await fetch(`${serverUrl}/tabs/${tabId}/evaluate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId: USER, expression: 'window.__ZONE' }),
    });
    const evalBody = await evalRes.json();
    expect(evalBody.result).toBe('injected');

    await fetch(`${serverUrl}/tabs/${tabId}/clear-init-scripts`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId: USER }),
    });
  });

  test('404 for unknown tab', async () => {
    const res = await fetch(`${serverUrl}/tabs/no-such-tab/init-script`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId: USER, script: 'window.__X=1;' }),
    });
    expect(res.status).toBe(404);
  });
});
