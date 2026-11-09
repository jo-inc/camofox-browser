/**
 * Regression tests for self-closing popup handling (issue #15252).
 *
 * The bug: operating on a popup tab whose page closed itself (e.g. an OAuth
 * popup calling window.close()) raised the generic Playwright error
 * "Target page, context or browser has been closed". handleRouteError read that
 * as a dead BrowserContext and called destroySession(userId), which tore down
 * EVERY tab across ALL sessionKey groups for that user.
 *
 * These tests assert the fixed behavior:
 *   (a) operating on a self-closed popup tab does NOT destroy other
 *       sessionKeys' tabs (the session and the unrelated tab survive), and
 *   (b) a self-closed popup is deregistered from GET /tabs.
 */

import crypto from 'crypto';
import { startServer, stopServer, getServerUrl } from '../helpers/startServer.js';
import { startTestSite, stopTestSite, getTestSiteUrl } from '../helpers/testSite.js';

describe('Self-closing popup isolation (#15252)', () => {
  let serverUrl;
  let testSiteUrl;

  beforeAll(async () => {
    await startServer(0, { SESSION_TIMEOUT_MS: '30000' });
    serverUrl = getServerUrl();
    await startTestSite();
    testSiteUrl = getTestSiteUrl();
  }, 120000);

  afterAll(async () => {
    await stopTestSite();
    await stopServer();
  }, 30000);

  async function api(method, path, body) {
    const res = await fetch(`${serverUrl}${path}`, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    });
    let data = null;
    try { data = await res.json(); } catch { /* non-JSON */ }
    return { status: res.status, data };
  }

  const delay = (ms) => new Promise((r) => setTimeout(r, ms));

  test('a self-closed popup does not destroy another sessionKey\'s tabs, and is deregistered from GET /tabs', async () => {
    const userId = crypto.randomUUID();
    const sessionKeyA = crypto.randomUUID();
    const sessionKeyB = crypto.randomUUID();

    try {
      // --- sessionKey A: an unrelated tab that MUST survive the popup close ---
      const createA = await api('POST', '/tabs', {
        userId, sessionKey: sessionKeyA, url: `${testSiteUrl}/pageA`,
      });
      expect(createA.status).toBe(200);
      const tabA = createA.data.tabId;
      expect(tabA).toBeDefined();

      // --- sessionKey B: a source tab that spawns a popup ---
      const createB = await api('POST', '/tabs', {
        userId, sessionKey: sessionKeyB, url: `${testSiteUrl}/popup-source`,
      });
      expect(createB.status).toBe(200);
      const sourceTab = createB.data.tabId;
      expect(sourceTab).toBeDefined();

      // Open a popup that does NOT auto-close yet, so we can capture its tabId.
      const openPopup = await api('POST', `/tabs/${sourceTab}/evaluate`, {
        userId, expression: "Boolean(window.open('/popup-target', '_blank'))",
      });
      expect(openPopup.status).toBe(200);
      await delay(1500); // let the popup event register

      const listBefore = await api('GET', `/tabs?userId=${userId}`);
      expect(listBefore.status).toBe(200);
      const popupTab = listBefore.data.tabs.find((t) => t.url.includes('/popup-target'));
      expect(popupTab).toBeDefined();
      const popupTabId = popupTab.tabId;

      // The popup closes itself, exactly like an OAuth popup calling
      // window.close(). The evaluate that triggers it may itself reject with the
      // "page closed" error — that is the misclassification trigger.
      await api('POST', `/tabs/${popupTabId}/evaluate`, {
        userId, expression: 'window.close()',
      }).catch(() => {});
      await delay(1000); // let the page 'close' handler deregister the tab

      // Operate on the now-dead popup tab. Pre-fix this raised a dead-context
      // error and destroyed the whole user session. Post-fix it is a recoverable
      // per-tab miss (404), and the context/session stay intact.
      const opOnDead = await api('POST', `/tabs/${popupTabId}/evaluate`, {
        userId, expression: '1 + 1',
      });
      expect([404, 410]).toContain(opOnDead.status);

      // (b) The self-closed popup is deregistered from GET /tabs.
      const listAfter = await api('GET', `/tabs?userId=${userId}`);
      expect(listAfter.status).toBe(200);
      const stillPopup = listAfter.data.tabs.find((t) => t.tabId === popupTabId);
      expect(stillPopup).toBeUndefined();

      // (a) sessionKey A's tab survived — it is still listed...
      const survivor = listAfter.data.tabs.find((t) => t.tabId === tabA);
      expect(survivor).toBeDefined();

      // ...and is still operable (the BrowserContext was not torn down).
      const evalA = await api('POST', `/tabs/${tabA}/evaluate`, {
        userId, expression: '21 + 21',
      });
      expect(evalA.status).toBe(200);
      expect(evalA.data.result).toBe(42);
    } finally {
      await api('DELETE', `/sessions/${userId}`).catch(() => {});
    }
  }, 90000);
});
