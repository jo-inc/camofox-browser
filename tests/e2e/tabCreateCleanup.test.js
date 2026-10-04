import { createClient } from '../helpers/client.js';
import { getSharedEnv } from './sharedEnv.js';

// POST /tabs registers the tab before it validates or loads the URL. A failed
// creation must not leave that tab open under an id the client never received.
describe('Tab create cleanup', () => {
  let serverUrl;
  let testSiteUrl;

  beforeAll(() => {
    const env = getSharedEnv();
    serverUrl = env.serverUrl;
    testSiteUrl = env.testSiteUrl;
  });

  async function listTabIds(client) {
    const { tabs } = await client.request('GET', `/tabs?userId=${encodeURIComponent(client.userId)}`);
    return tabs.map(tab => tab.tabId);
  }

  function createTabRequest(client, url, options = {}) {
    return client.request('POST', '/tabs', {
      userId: client.userId, sessionKey: client.sessionKey, url,
    }, options);
  }

  test('a blocked URL scheme leaves no tab behind', async () => {
    const client = createClient(serverUrl);
    try {
      const { tabId: sentinel } = await client.createTab(`${testSiteUrl}/pageA`);

      await expect(createTabRequest(client, 'ftp://example.com/')).rejects.toMatchObject({ status: 400 });

      expect(await listTabIds(client)).toEqual([sentinel]);
    } finally {
      await client.cleanup();
    }
  });

  test('a navigation that outlives the route deadline leaves no tab behind', async () => {
    const client = createClient(serverUrl);
    try {
      const { tabId: sentinel } = await client.createTab(`${testSiteUrl}/pageA`);

      // The route deadline (30 s by default) fires before the navigation's own
      // 30 s timeout, which starts later; the message names the deadline.
      await expect(createTabRequest(client, `${testSiteUrl}/slow-navigation`, { timeout: 45000 }))
        .rejects.toMatchObject({ status: 500, message: expect.stringContaining('tab create timed out') });

      expect(await listTabIds(client)).toEqual([sentinel]);

      // Recheck after a short delay for a leftover registration.
      await new Promise(resolve => setTimeout(resolve, 2000));
      expect(await listTabIds(client)).toEqual([sentinel]);
    } finally {
      await client.cleanup();
    }
  }, 60000);
});
