import fs from 'node:fs';
import { createClient } from '../helpers/client.js';
import { proxyTargetUrl, startFakeProxy } from '../helpers/fakeProxy.js';
import { getServerProcessPid, getServerUrl, startServer, stopServer } from '../helpers/startServer.js';
import { getTestSiteUrl, startTestSite, stopTestSite } from '../helpers/testSite.js';

const CLEAN_SERVER_ENV = {
  NODE_ENV: 'test',
  PRE_WARM_BROWSER: 'false',
  PROXY_HOST: '',
  PROXY_PORT: '',
  PROXY_PORTS: '',
  PROXY_STRATEGY: '',
  PROXY_PROVIDER: '',
  PROXY_USERNAME: '',
  PROXY_PASSWORD: '',
  PROXY_BACKCONNECT_HOST: '',
  PROXY_BACKCONNECT_PORT: '',
  CAMOFOX_ACCESS_KEY: '',
  CAMOFOX_API_KEY: '',
  CAMOFOX_ADMIN_KEY: '',
  CAMOFOX_CRASH_REPORT_ENABLED: 'false',
  SENTRY_DSN: '',
};

async function expectRequestError(promise, { status, code, recovery, retryable }) {
  try {
    await promise;
    throw new Error('request unexpectedly succeeded');
  } catch (err) {
    expect(err.status).toBe(status);
    if (code) expect(err.data?.code).toBe(code);
    if (recovery) expect(err.data?.recovery).toBe(recovery);
    if (retryable !== undefined) expect(err.data?.retryable).toBe(retryable);
    return err;
  }
}

function processDescendants(pid) {
  let children = [];
  try {
    const raw = fs.readFileSync(`/proc/${pid}/task/${pid}/children`, 'utf8').trim();
    children = raw ? raw.split(/\s+/).map(Number) : [];
  } catch {
    return [];
  }
  return children.flatMap(childPid => [childPid, ...processDescendants(childPid)]);
}

function findBrowserProcessPid(serverPid) {
  for (const pid of processDescendants(serverPid)) {
    try {
      const command = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').replaceAll('\0', ' ');
      if (/(camoufox|firefox)/i.test(command) && !command.includes('-contentproc')) return pid;
    } catch {
      // Process exited while the tree was being inspected.
    }
  }
  return null;
}

async function waitFor(predicate, { attempts = 40, delayMs = 250 } = {}) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (await predicate()) return;
    await new Promise(resolve => setTimeout(resolve, delayMs));
  }
  throw new Error('timed out waiting for condition');
}

describe('request-level proxy API contract', () => {
  let baseUrl;
  let testSiteUrl;
  let proxy;

  beforeAll(async () => {
    await startTestSite();
    testSiteUrl = getTestSiteUrl();
    proxy = await startFakeProxy();
    await startServer(0, CLEAN_SERVER_ENV);
    baseUrl = getServerUrl();
  }, 120000);

  beforeEach(() => {
    proxy.clearRequests();
  });

  afterAll(async () => {
    await stopServer();
    await proxy?.stop();
    await stopTestSite();
  }, 30000);

  test('creates and reuses one proxied user session', async () => {
    const client = createClient(baseUrl);
    const requestProxy = { server: proxy.server };
    try {
      const first = await client.createTab(proxyTargetUrl(testSiteUrl, '/pageA'), { proxy: requestProxy });
      const second = await client.createTab(proxyTargetUrl(testSiteUrl, '/pageB'), { proxy: requestProxy });

      expect(first.url).toContain('/pageA');
      expect(first.proxied).toBe(true);
      expect(second.url).toContain('/pageB');
      expect(second.proxied).toBe(true);
      expect(proxy.requests.some(request => request.path === '/pageA')).toBe(true);
      expect(proxy.requests.some(request => request.path === '/pageB')).toBe(true);
      expect(proxy.requests.every(request => request.hadProxyAuthorization === false)).toBe(true);
    } finally {
      await client.cleanup();
    }
  }, 60000);

  test('preserves literal request credentials when authenticating to the proxy', async () => {
    const credentials = { username: 'request%user', password: 'p%2Fssword' };
    const authenticatedProxy = await startFakeProxy(credentials);
    const client = createClient(baseUrl);
    try {
      const created = await client.createTab(proxyTargetUrl(testSiteUrl, '/pageA'), {
        proxy: { server: authenticatedProxy.server, ...credentials },
      });
      expect(created.proxied).toBe(true);
      expect(authenticatedProxy.requests.some(request => request.hadProxyAuthorization)).toBe(true);
    } finally {
      await client.cleanup();
      await authenticatedProxy.stop();
    }
  }, 60000);

  test('reports direct routing without exposing proxy details', async () => {
    const client = createClient(baseUrl);
    try {
      const created = await client.createTab(`${testSiteUrl}/pageA`);
      expect(created.url).toContain('/pageA');
      expect(created.proxied).toBe(false);
      expect(created).not.toHaveProperty('proxy');
    } finally {
      await client.cleanup();
    }
  }, 60000);

  test('rejects a different proxy for an existing user session', async () => {
    const client = createClient(baseUrl);
    try {
      await client.createTab(null, { proxy: { server: proxy.server } });
      await expectRequestError(
        client.createTab(null, {
          retries: 0,
          proxy: { server: proxy.server, username: 'different-user' },
        }),
        { status: 409, code: 'proxy_conflict', recovery: 'delete_session', retryable: false },
      );
    } finally {
      await client.cleanup();
    }
  }, 60000);

  test('rejects malformed, null, and unsupported proxy input', async () => {
    const malformed = createClient(baseUrl);
    const nullProxy = createClient(baseUrl);
    const unsupported = createClient(baseUrl);
    try {
      await expectRequestError(
        malformed.createTab(null, { retries: 0, proxy: { server: 'ftp://invalid.example' } }),
        { status: 400 },
      );
      await expectRequestError(
        nullProxy.createTab(null, { retries: 0, proxy: null }),
        { status: 400 },
      );
      await expectRequestError(
        unsupported.createTab(null, {
          retries: 0,
          proxy: { server: proxy.server, bypass: '*.internal' },
        }),
        { status: 400 },
      );
    } finally {
      await malformed.cleanup();
      await nullProxy.cleanup();
      await unsupported.cleanup();
    }
  }, 60000);

  test('documents the cookie-import-first conflict instead of silently replacing the session', async () => {
    const client = createClient(baseUrl);
    try {
      await client.request('POST', `/sessions/${client.userId}/cookies`, {
        cookies: [{ name: 'session', value: 'test', domain: '.example.com', path: '/' }],
      });
      await expectRequestError(
        client.createTab(null, { retries: 0, proxy: { server: proxy.server } }),
        { status: 409, code: 'proxy_conflict', recovery: 'delete_session', retryable: false },
      );
    } finally {
      await client.cleanup();
    }
  }, 60000);

  test('cookie import reuses a recently recovered request proxy', async () => {
    const client = createClient(baseUrl);
    const cleanupOptions = {
      dryRun: false,
      minIdleMs: 0,
      minTabsPerSession: 0,
      maxTabsToClose: 10,
      closeEmptySessions: true,
    };
    try {
      await client.createTab(proxyTargetUrl(testSiteUrl, '/pageA'), {
        proxy: { server: proxy.server },
      });
      await client.request('POST', '/pressure/cleanup', cleanupOptions);
      await client.request('POST', '/pressure/cleanup', cleanupOptions);

      await client.request('POST', `/sessions/${client.userId}/cookies`, {
        cookies: [{ name: 'session', value: 'recovered', domain: '.example.com', path: '/' }],
      });
      const created = await client.createTab(proxyTargetUrl(testSiteUrl, '/pageB'));
      expect(created.proxied).toBe(true);
      expect(proxy.requests.some(request => request.path === '/pageB')).toBe(true);
    } finally {
      await client.cleanup();
    }
  }, 60000);

  test('reuses the proxy after pressure cleanup and proves POST /tabs releases its page lease', async () => {
    const client = createClient(baseUrl);
    const cleanupOptions = {
      dryRun: false,
      minIdleMs: 0,
      minTabsPerSession: 0,
      maxTabsToClose: 10,
      closeEmptySessions: true,
    };
    try {
      await client.createTab(proxyTargetUrl(testSiteUrl, '/pageA'), {
        proxy: { server: proxy.server },
      });
      await client.request('POST', '/pressure/cleanup', cleanupOptions);
      await client.request('POST', '/pressure/cleanup', cleanupOptions);
      proxy.clearRequests();
      const recovered = await client.createTab(proxyTargetUrl(testSiteUrl, '/pageB'));
      expect(recovered.url).toContain('/pageB');
      expect(recovered.proxied).toBe(true);
      expect(proxy.requests.some(request => request.path === '/pageB')).toBe(true);
    } finally {
      await client.cleanup();
    }
  }, 60000);
  test('reuses the proxy after a real browser disconnect', async () => {
    if (process.platform !== 'linux') return;

    const client = createClient(baseUrl);
    try {
      await client.createTab(proxyTargetUrl(testSiteUrl, '/pageA'), {
        proxy: { server: proxy.server },
      });
      const browserPid = findBrowserProcessPid(getServerProcessPid());
      expect(browserPid).not.toBeNull();
      process.kill(browserPid, 'SIGKILL');

      await waitFor(async () => {
        try {
          const response = await fetch(`${baseUrl}/health`);
          const health = await response.json();
          return health.browserConnected === false || health.browserRunning === false;
        } catch {
          return false;
        }
      });

      const recovered = await client.createTab(proxyTargetUrl(testSiteUrl, '/pageB'));
      expect(recovered.proxied).toBe(true);
      expect(proxy.requests.some(request => request.path === '/pageB')).toBe(true);
    } finally {
      await client.cleanup();
    }
  }, 60000);
});

describe('request-level proxy and global proxy mode', () => {
  let baseUrl;

  beforeAll(async () => {
    await startServer(0, {
      ...CLEAN_SERVER_ENV,
      PROXY_HOST: '127.0.0.1',
      PROXY_PORT: '65530',
      PROXY_PORTS: '65530',
      PROXY_STRATEGY: 'round_robin',
    });
    baseUrl = getServerUrl();
  }, 60000);

  afterAll(async () => {
    await stopServer();
  }, 30000);

  test('rejects mixed request-proxy and global-pool mode before browser creation', async () => {
    const client = createClient(baseUrl);
    await expectRequestError(
      client.createTab(null, {
        retries: 0,
        proxy: { server: 'http://127.0.0.1:65531' },
      }),
      { status: 409, code: 'proxy_mode_conflict', recovery: 'remove_request_proxy', retryable: false },
    );
  });
});
