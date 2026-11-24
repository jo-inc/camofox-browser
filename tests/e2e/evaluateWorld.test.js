import { createClient } from '../helpers/client.js';
import { getSharedEnv } from './sharedEnv.js';

// Camoufox's default world is a sandbox that cannot see page scripts' state; /evaluate and
// /init-script run in the page's own world unless the caller asks for the sandbox.
describe('Evaluate and init-script worlds', () => {
  let serverUrl;
  let testSiteUrl;

  beforeAll(() => {
    const env = getSharedEnv();
    serverUrl = env.serverUrl;
    testSiteUrl = env.testSiteUrl;
  });

  const evaluate = (client, tabId, body) =>
    client.request('POST', `/tabs/${tabId}/evaluate`, { userId: client.userId, ...body });

  test('evaluate reads a page global by default, and not from the isolated world', async () => {
    const client = createClient(serverUrl);
    try {
      const { tabId } = await client.createTab(`${testSiteUrl}/pageGlobal`);
      const main = await evaluate(client, tabId, { expression: '({ user: window.appState.user, title: document.title })' });
      expect(main.result).toEqual({ user: 'ada', title: 'plain' });
      const isolated = await evaluate(client, tabId, { expression: 'typeof window.appState', world: 'isolated' });
      expect(isolated.result).toBe('undefined');
      const prefixed = await evaluate(client, tabId, { expression: 'mw:typeof window.appState', world: 'isolated' });
      expect(prefixed.result).toBe('object');
    } finally {
      await client.cleanup();
    }
  });

  test('a promise-returning evaluate reaches the page global too', async () => {
    const client = createClient(serverUrl);
    try {
      const { tabId } = await client.createTab(`${testSiteUrl}/pageGlobal`);
      const result = await evaluate(client, tabId, {
        expression: '(async () => { await new Promise(r => setTimeout(r, 20)); return window.appState.user; })()',
      });
      expect(result.result).toBe('ada');
    } finally {
      await client.cleanup();
    }
  });

  test('a syntax error in the main world is still 400 invalid_expression', async () => {
    const client = createClient(serverUrl);
    try {
      const { tabId } = await client.createTab(`${testSiteUrl}/pageGlobal`);
      const err = await evaluate(client, tabId, { expression: 'return 1' }).catch(e => e);
      expect(err.status).toBe(400);
      expect(err.data.code).toBe('invalid_expression');
    } finally {
      await client.cleanup();
    }
  });

  test('an unknown world is refused', async () => {
    const client = createClient(serverUrl);
    try {
      const { tabId } = await client.createTab(`${testSiteUrl}/pageGlobal`);
      const err = await evaluate(client, tabId, { expression: '1', world: 'page' }).catch(e => e);
      expect(err.status).toBe(400);
      const initErr = await client.request('POST', `/tabs/${tabId}/init-script`, { userId: client.userId, script: '1', world: 'page' }).catch(e => e);
      expect(initErr.status).toBe(400);
    } finally {
      await client.cleanup();
    }
  });

  test.each([
    [undefined, 'hooked'],
    ['isolated', 'plain'],
  ])('an init script in world %s: the page reads %s', async (world, title) => {
    const client = createClient(serverUrl);
    try {
      const { tabId } = await client.createTab(`${testSiteUrl}/pageA`);
      await client.request('POST', `/tabs/${tabId}/init-script`, {
        userId: client.userId, script: "window.__initHook = 'installed';", ...(world ? { world } : {}),
      });
      await client.navigate(tabId, `${testSiteUrl}/pageGlobal`);
      const result = await evaluate(client, tabId, { expression: 'document.title', world: 'isolated' });
      expect(result.result).toBe(title);
    } finally {
      await client.cleanup();
    }
  });
});
