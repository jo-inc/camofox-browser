import { createClient } from '../helpers/client.js';
import { getSharedEnv } from './sharedEnv.js';

describe('Clicking element refs', () => {
  let serverUrl;
  let testSiteUrl;

  beforeAll(() => {
    const env = getSharedEnv();
    serverUrl = env.serverUrl;
    testSiteUrl = env.testSiteUrl;
  });

  test('clicks the unnamed element represented by a ref', async () => {
    const client = createClient(serverUrl);

    try {
      const { tabId } = await client.createTab(`${testSiteUrl}/click-refs`);
      const snapshot = await client.getSnapshot(tabId);
      const unnamedButton = snapshot.snapshot.split('\n').find((line) => /^\s*- button \[e\d+\]/.test(line));
      const ref = unnamedButton?.match(/\[(e\d+)\]/)?.[1];

      expect(ref).toBeDefined();
      await client.click(tabId, { ref });

      const updatedSnapshot = await client.getSnapshot(tabId);
      expect(updatedSnapshot.snapshot).toContain('Clicked unnamed button');
      expect(updatedSnapshot.snapshot).not.toContain('Wrong navigation button');
    } finally {
      await client.cleanup();
    }
  });

  test('matches button names exactly when resolving refs', async () => {
    const client = createClient(serverUrl);

    try {
      const { tabId } = await client.createTab(`${testSiteUrl}/click-refs`);
      const snapshot = await client.getSnapshot(tabId);
      const saveButton = snapshot.snapshot.split('\n').find((line) => /- button "Save" \[e\d+\]/.test(line));
      const ref = saveButton?.match(/\[(e\d+)\]/)?.[1];

      expect(ref).toBeDefined();
      await client.click(tabId, { ref });

      const updatedSnapshot = await client.getSnapshot(tabId);
      expect(updatedSnapshot.snapshot).toContain('Clicked Save');
      expect(updatedSnapshot.snapshot).not.toContain('Clicked Save all');
    } finally {
      await client.cleanup();
    }
  });

  test('clicks the unnamed element represented by a frame ref', async () => {
    const client = createClient(serverUrl);

    try {
      const { tabId } = await client.createTab(`${testSiteUrl}/click-refs-frame`);
      const snapshot = await client.getSnapshot(tabId);
      const unnamedButton = snapshot.snapshot.split('\n').find((line) => /^\s*- button \[e\d+\]/.test(line));
      const ref = unnamedButton?.match(/\[(e\d+)\]/)?.[1];

      expect(ref).toBeDefined();
      await client.click(tabId, { ref });

      const updatedSnapshot = await client.getSnapshot(tabId);
      expect(updatedSnapshot.snapshot).toContain('Clicked unnamed frame button');
      expect(updatedSnapshot.snapshot).not.toContain('Wrong frame button');
    } finally {
      await client.cleanup();
    }
  });
});
