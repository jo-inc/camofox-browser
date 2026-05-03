/**
 * Integration regression tests for BugHunter#174 — safePageClose tab leak.
 *
 * Fix verification:
 * 1. Open + close 100 tabs sequentially: activeTabs from /health must be 0 at end.
 * 2. Open 30 tabs, force-close 10 via DELETE, confirm /health shows 0 leaks
 *    (the orphan reaper is not exercised here because real page.close() works;
 *     orphan reaper is exercised by the unit test with the simulated race).
 */
import { describe, test, expect, beforeAll } from '@jest/globals';
import { createClient } from '../helpers/client.js';
import { getSharedEnv } from './sharedEnv.js';

describe('Tab leak regression (BugHunter#174)', () => {
  let serverUrl;
  let testSiteUrl;

  beforeAll(() => {
    const env = getSharedEnv();
    serverUrl = env.serverUrl;
    testSiteUrl = env.testSiteUrl;
  });

  test(
    'open + close 100 tabs: activeTabs reaches 0 with no leaks',
    async () => {
      const client = createClient(serverUrl);
      try {
        for (let i = 0; i < 100; i++) {
          const { tabId } = await client.createTab(`${testSiteUrl}/pageA`);
          await client.closeTab(tabId);
        }
        // Drain client.tabs (cleanup would double-close, avoid that)
        client.tabs = [];

        const health = await client.health();
        // activeTabs is now driven by context.pages().length, not bookkeeping.
        // If any Playwright Page leaked, this count would be non-zero.
        expect(health.activeTabs).toBe(0);
      } finally {
        await client.cleanup();
      }
    },
    180_000,
  );

  test(
    'open 30 tabs, close all via DELETE, activeTabs is 0',
    async () => {
      const client = createClient(serverUrl);
      try {
        const tabIds = [];
        for (let i = 0; i < 30; i++) {
          const { tabId } = await client.createTab(`${testSiteUrl}/pageA`);
          tabIds.push(tabId);
        }

        for (const tabId of tabIds) {
          await client.closeTab(tabId);
        }
        client.tabs = [];

        const health = await client.health();
        expect(health.activeTabs).toBe(0);
      } finally {
        await client.cleanup();
      }
    },
    180_000,
  );
});
