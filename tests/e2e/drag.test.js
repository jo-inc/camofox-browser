import { createClient } from '../helpers/client.js';
import { getSharedEnv } from './sharedEnv.js';

describe('Atomic trusted drag', () => {
  let serverUrl;
  let testSiteUrl;

  beforeAll(() => {
    const env = getSharedEnv();
    serverUrl = env.serverUrl;
    testSiteUrl = env.testSiteUrl;
  });

  test('dispatches browser mouse events and lands in the drag target', async () => {
    const client = createClient(serverUrl);

    try {
      const { tabId } = await client.createTab(`${testSiteUrl}/drag`);
      const result = await client.drag(tabId, {
        start: { x: 90, y: 140 },
        end: { x: 450, y: 140 },
        steps: 8,
        durationMs: 120,
      });

      expect(result).toMatchObject({
        ok: true,
        start: { x: 90, y: 140 },
        end: { x: 450, y: 140 },
        steps: 8,
        durationMs: 120,
        button: 'left',
      });

      const status = await client.evaluate(tabId, "document.getElementById('status').textContent");
      expect(status.result).toMatch(/^dropped:\d+$/);
      expect(Number(status.result.split(':')[1])).toBeGreaterThan(0);
    } finally {
      await client.cleanup();
    }
  }, 120000);

  test('enforces the route contract before browser dispatch', async () => {
    const client = createClient(serverUrl);

    await expect(client.request('POST', '/tabs/missing-tab/drag', {
      userId: client.userId,
      start: { x: 10, y: 20 },
      end: { x: 30, y: 40 },
      unexpected: true,
    })).rejects.toMatchObject({ status: 400 });

    await expect(client.request('POST', '/tabs/missing-tab/drag', {
      userId: client.userId,
      start: { x: 10, y: 20, z: 30 },
      end: { x: 30, y: 40 },
    })).rejects.toMatchObject({ status: 400 });

    await expect(client.request('POST', '/tabs/missing-tab/drag', {
      userId: `  ${client.userId}  `,
      start: { x: 10, y: 20 },
      end: { x: 30, y: 40 },
    })).rejects.toMatchObject({ status: 404 });
  });
});
