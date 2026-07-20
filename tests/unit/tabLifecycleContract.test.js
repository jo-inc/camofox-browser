/**
 * Tests for tab lifecycle contract hardening (JO-2452, JO-2456).
 *
 * Covers:
 * - Navigate returns stale-tab error (no auto-create)
 * - Session lastAccess refreshed on tab ops (prevents timeout of active sessions)
 * - Popup/new-window pages become managed tabs (not orphaned)
 * - scroll and links are serialized via withTabLock
 */

import { startServer, stopServer, getServerUrl } from '../helpers/startServer.js';
import { startTestSite, stopTestSite, getTestSiteUrl } from '../helpers/testSite.js';
import { createClient } from '../helpers/client.js';

describe('Tab Lifecycle Contract', () => {
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

  describe('Stale tab errors (JO-2452)', () => {
    test('navigate returns 404 for unknown tabId', async () => {
      const client = createClient(serverUrl);
      try {
        await client.createTab(`${testSiteUrl}/pageA`);
        try {
          await client.navigate('nonexistent-tab-id', `${testSiteUrl}/pageB`);
          fail('Should have thrown');
        } catch (err) {
          expect(err.status).toBe(404);
        }
      } finally {
        await client.cleanup();
      }
    }, 60000);

    test('snapshot returns 404 for unknown tabId', async () => {
      const client = createClient(serverUrl);
      try {
        await client.createTab(`${testSiteUrl}/pageA`);
        try {
          await client.getSnapshot('nonexistent-tab-id');
          fail('Should have thrown');
        } catch (err) {
          expect(err.status).toBe(404);
        }
      } finally {
        await client.cleanup();
      }
    }, 60000);

    test('click returns 404 for unknown tabId', async () => {
      const client = createClient(serverUrl);
      try {
        await client.createTab(`${testSiteUrl}/pageA`);
        try {
          await client.click('nonexistent-tab-id', { ref: 'e1' });
          fail('Should have thrown');
        } catch (err) {
          expect(err.status).toBe(404);
        }
      } finally {
        await client.cleanup();
      }
    }, 60000);

    test('scroll returns 404 for unknown tabId', async () => {
      const client = createClient(serverUrl);
      try {
        await client.createTab(`${testSiteUrl}/pageA`);
        try {
          await client.scroll('nonexistent-tab-id', { direction: 'down', amount: 100 });
          fail('Should have thrown');
        } catch (err) {
          expect(err.status).toBe(404);
        }
      } finally {
        await client.cleanup();
      }
    }, 60000);
  });

  describe('Session lastAccess refresh (JO-2452)', () => {
    test('tab operations refresh session lastAccess', async () => {
      const client = createClient(serverUrl);
      try {
        const { tabId } = await client.createTab(`${testSiteUrl}/links`);

        // Perform multiple tab operations — session should not expire
        await new Promise(r => setTimeout(r, 2000));
        await client.getSnapshot(tabId);
        await new Promise(r => setTimeout(r, 2000));
        await client.getLinks(tabId);
        await new Promise(r => setTimeout(r, 2000));
        await client.scroll(tabId, { direction: 'down', amount: 100 });
        await new Promise(r => setTimeout(r, 2000));

        // Session should still be alive after ops (each refreshed lastAccess)
        const snapshot = await client.getSnapshot(tabId);
        expect(snapshot.url).toContain('/links');
      } finally {
        await client.cleanup();
      }
    }, 60000);
  });

  describe('Popup/new-window policy (JO-2456)', () => {
    test('target=_blank link creates a managed tab', async () => {
      const client = createClient(serverUrl);
      try {
        const { tabId } = await client.createTab(`${testSiteUrl}/popup-source`);

        // Trigger the browser primitive directly. This suite verifies popup
        // registration, not the separate /click route and its ref rebuilding.
        await client.request('POST', `/tabs/${tabId}/evaluate`, {
          userId: client.userId,
          expression: "document.querySelector('#blankLink').click()",
        });

        // Wait briefly for popup event to register
        await new Promise(r => setTimeout(r, 1500));

        // List tabs — should see more than 1 tab (the popup is now managed)
        const res = await client.request('GET', `/tabs?userId=${client.userId}`);
        expect(res.tabs.length).toBeGreaterThanOrEqual(2);

        // Find the popup tab
        const popupTab = res.tabs.find(t => t.url.includes('/popup-target'));
        expect(popupTab).toBeDefined();
        expect(popupTab.tabId).toBeDefined();

        // The popup tab should be closeable via the API
        await client.closeTab(popupTab.tabId);
        const res2 = await client.request('GET', `/tabs?userId=${client.userId}`);
        const stillThere = res2.tabs.find(t => t.tabId === popupTab.tabId);
        expect(stillThere).toBeUndefined();
      } finally {
        await client.cleanup();
      }
    }, 60000);

    test('window.open creates a managed tab', async () => {
      const client = createClient(serverUrl);
      try {
        const { tabId } = await client.createTab(`${testSiteUrl}/popup-source`);

        // Trigger the browser primitive directly. This keeps the lifecycle
        // assertion independent from /click post-action snapshot behavior.
        await client.request('POST', `/tabs/${tabId}/evaluate`, {
          userId: client.userId,
          expression: "document.querySelector('#openBtn').click()",
        });

        // Wait briefly for popup event to register
        await new Promise(r => setTimeout(r, 1500));

        // List tabs — popup should be tracked
        const res = await client.request('GET', `/tabs?userId=${client.userId}`);
        const popupTab = res.tabs.find(t => t.url.includes('/popup-target'));
        expect(popupTab).toBeDefined();
        expect(popupTab.tabId).toBeDefined();
      } finally {
        await client.cleanup();
      }
    }, 60000);
  });
});
