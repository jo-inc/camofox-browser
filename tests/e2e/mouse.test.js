import { createClient } from '../helpers/client.js';
import { getSharedEnv } from './sharedEnv.js';

describe('Mouse endpoint', () => {
  let serverUrl;
  let testSiteUrl;

  beforeAll(() => {
    const env = getSharedEnv();
    serverUrl = env.serverUrl;
    testSiteUrl = env.testSiteUrl;
  });

  test('clicks viewport coordinates', async () => {
    const client = createClient(serverUrl);

    try {
      const { tabId } = await client.createTab(`${testSiteUrl}/mouse`);

      const result = await client.mouse(tabId, { x: 160, y: 120 });
      expect(result).toMatchObject({ ok: true, action: 'click', x: 160, y: 120 });

      const snapshot = await client.waitForSnapshotContains(tabId, 'Mouse clicked!');
      expect(snapshot.snapshot).toContain('Mouse clicked!');
    } finally {
      await client.cleanup();
    }
  });

  test('sends move/down/up actions at viewport coordinates', async () => {
    const client = createClient(serverUrl);

    try {
      const { tabId } = await client.createTab(`${testSiteUrl}/mouse`);

      await expect(client.mouse(tabId, { action: 'move', x: 160, y: 120 }))
        .resolves.toMatchObject({ ok: true, action: 'move', x: 160, y: 120 });
      let snapshot = await client.waitForSnapshotContains(tabId, 'Mouse moved!');
      expect(snapshot.snapshot).toContain('Mouse moved!');

      await expect(client.mouse(tabId, { action: 'down', x: 160, y: 120 }))
        .resolves.toMatchObject({ ok: true, action: 'down', x: 160, y: 120 });
      snapshot = await client.waitForSnapshotContains(tabId, 'Mouse down!');
      expect(snapshot.snapshot).toContain('Mouse down!');

      await expect(client.mouse(tabId, { action: 'up', x: 160, y: 120 }))
        .resolves.toMatchObject({ ok: true, action: 'up', x: 160, y: 120 });
    } finally {
      await client.cleanup();
    }
  });

  test('rejects invalid coordinates', async () => {
    const client = createClient(serverUrl);

    try {
      const { tabId } = await client.createTab(`${testSiteUrl}/mouse`);

      await expect(client.mouse(tabId, { x: 'not-a-number', y: 120 }))
        .rejects.toThrow('numeric x and y required');
    } finally {
      await client.cleanup();
    }
  });
});
