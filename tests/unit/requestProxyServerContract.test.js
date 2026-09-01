import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { jest } from '@jest/globals';
import { createRequestProxyRecoveryCache, REQUEST_PROXY_RECOVERY_REASONS } from '../../lib/request-proxy.js';
import {
  canPreserveSessionRecovery,
  createLifecycleEpoch,
  createSessionLifecycleTracker,
  isAutomaticSessionTeardown,
  publishSessionIfCurrent,
  runSessionCloseOnce,
} from '../../lib/session-lifecycle.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const serverSource = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
const recoverySource = `${serverSource}\n${fs.readFileSync(path.join(root, 'lib/new-page-recovery.js'), 'utf8')}`;
const workflows = [
  ['CI', fs.readFileSync(path.join(root, '.github/workflows/ci.yml'), 'utf8')],
  ['publish', fs.readFileSync(path.join(root, '.github/workflows/publish.yml'), 'utf8')],
];
const packageLock = JSON.parse(fs.readFileSync(path.join(root, 'package-lock.json'), 'utf8'));

describe('request proxy server integration contract', () => {
  test.each(workflows)('%s workflow uses Jest 30 filters and quarantines the browser proxy tests', (_name, source) => {
    expect(packageLock.packages['node_modules/jest'].version).toMatch(/^30\./);
    expect(source.match(/--testPathPatterns=/g)).toHaveLength(2);
    expect(source).not.toMatch(/--testPathPattern=/);
    expect(source).toMatch(/--testPathIgnorePatterns='[^']*requestProxyApi\\\.test/);
    expect(source).toMatch(/\(security\|tabRecycling\|cookies\|requestProxyApi\)\\\.test/);
  });

  test('keeps recovery metadata independent from 5xx Sentry reporting', () => {
    expect(serverSource).toContain('if (status >= 500 && !err.statusCode) {');
    expect(serverSource).not.toContain('status >= 500 && !err.statusCode && !recovery');
  });

  test('every automatic recovery reason is emitted by a real teardown path', () => {
    for (const reason of REQUEST_PROXY_RECOVERY_REASONS) {
      expect(recoverySource).toContain(`'${reason}'`);
    }
    expect(serverSource).toContain('`browser_restart:${reason}`');
  });

  test('keeps recovered credentials longer than both idle eviction timers', () => {
    expect(serverSource).toContain(
      'ttlMs: Math.max(SESSION_TIMEOUT_MS, TAB_INACTIVITY_MS) + 60_000',
    );
  });

  test('applies deterministic context defaults to request-proxied sessions even if global config is incomplete', () => {
    expect(serverSource).toContain('if (normalizedRequestProxy || !CONFIG.proxy.host) {');
  });

  test('treats navigation failure recovery as automatic proxy-preserving teardown', () => {
    const lifecycle = createSessionLifecycleTracker();
    const session = { generation: lifecycle.begin('nav-user') };
    const reason = 'nav_failure_recovery:navigate_failure';

    expect(isAutomaticSessionTeardown(reason)).toBe(true);
    expect(canPreserveSessionRecovery(lifecycle, 'nav-user', session, reason)).toBe(true);
  });

  test('explicit invalidation prevents a stale automatic close from republishing credentials', () => {
    const lifecycle = createSessionLifecycleTracker();
    const cache = createRequestProxyRecoveryCache();
    const generation = lifecycle.begin('race-user');
    const staleSession = {
      generation,
      requestProxy: { server: 'http://proxy.example:8080', username: 'u', password: 'p' },
    };

    lifecycle.invalidate('race-user');
    cache.delete('race-user');
    if (canPreserveSessionRecovery(lifecycle, 'race-user', staleSession, 'session_timeout')) {
      cache.remember('race-user', staleSession.requestProxy);
    }

    expect(cache.get('race-user')).toBeNull();
  });

  test('an invalidated in-flight creation closes its context and is never left published', async () => {
    const lifecycle = createSessionLifecycleTracker();
    const sessions = new Map();
    const generation = lifecycle.begin('creation-race');
    let releaseCreated;
    let markCreatedStarted;
    const createdBlocked = new Promise(resolve => { releaseCreated = resolve; });
    const createdStarted = new Promise(resolve => { markCreatedStarted = resolve; });
    const context = { close: jest.fn(async () => {}) };
    const session = { context, generation };

    const publication = publishSessionIfCurrent({
      sessions,
      userId: 'creation-race',
      session,
      generation,
      lifecycle,
      onCreated: async () => {
        markCreatedStarted();
        await createdBlocked;
      },
      onStale: stale => stale.context.close(),
    });
    await createdStarted;
    lifecycle.invalidate('creation-race');
    releaseCreated();

    await expect(publication).resolves.toBe(false);
    expect(sessions.has('creation-race')).toBe(false);
    expect(context.close).toHaveBeenCalledTimes(1);
  });

  test('an automatic close during publication keeps proxy recovery and owns teardown', async () => {
    const lifecycle = createSessionLifecycleTracker();
    const cache = createRequestProxyRecoveryCache();
    const sessions = new Map();
    const generation = lifecycle.begin('automatic-publication-race');
    const requestProxy = {
      server: 'http://proxy.example:8080',
      username: 'u',
      password: 'p',
    };
    const session = { generation, requestProxy };
    const closeReasons = [];
    let releaseCreated;
    let markCreatedStarted;
    const createdBlocked = new Promise(resolve => { releaseCreated = resolve; });
    const createdStarted = new Promise(resolve => { markCreatedStarted = resolve; });

    const closeSession = reason => runSessionCloseOnce(session, async () => {
      closeReasons.push(reason);
      if (canPreserveSessionRecovery(lifecycle, 'automatic-publication-race', session, reason)) {
        cache.remember('automatic-publication-race', requestProxy);
      } else {
        cache.delete('automatic-publication-race');
        lifecycle.invalidate('automatic-publication-race');
      }
      sessions.delete('automatic-publication-race');
    });

    const publication = publishSessionIfCurrent({
      sessions,
      userId: 'automatic-publication-race',
      session,
      generation,
      lifecycle,
      onCreated: async () => {
        markCreatedStarted();
        await createdBlocked;
      },
      onStale: () => closeSession('session_creation_invalidated'),
    });
    await createdStarted;
    await closeSession('session_timeout');
    releaseCreated();

    await expect(publication).resolves.toBe(false);
    expect(closeReasons).toEqual(['session_timeout']);
    expect(cache.get('automatic-publication-race')).toEqual(requestProxy);
  });

  test('a browser lifecycle change rejects a context during publication', async () => {
    const lifecycle = createSessionLifecycleTracker();
    const browserLifecycle = createLifecycleEpoch();
    const sessions = new Map();
    const generation = lifecycle.begin('browser-restart-race');
    const browserGeneration = browserLifecycle.current();
    const context = { close: jest.fn(async () => {}) };
    const session = { context, generation };
    let releaseCreated;
    let markCreatedStarted;
    let staleCause = null;
    const createdBlocked = new Promise(resolve => { releaseCreated = resolve; });
    const createdStarted = new Promise(resolve => { markCreatedStarted = resolve; });

    const publication = publishSessionIfCurrent({
      sessions,
      userId: 'browser-restart-race',
      session,
      generation,
      lifecycle,
      isStillCurrent: () => browserLifecycle.isCurrent(browserGeneration),
      onCreated: async () => {
        markCreatedStarted();
        await createdBlocked;
      },
      onStale: async (stale, cause) => {
        staleCause = cause;
        await stale.context.close();
      },
    });
    await createdStarted;
    browserLifecycle.advance();
    releaseCreated();

    await expect(publication).resolves.toBe(false);
    expect(staleCause).toBe('external_invalidated');
    expect(sessions.has('browser-restart-race')).toBe(false);
    expect(context.close).toHaveBeenCalledTimes(1);
  });

  test('released lifecycle generations do not accumulate or suffer ABA reuse', () => {
    const lifecycle = createSessionLifecycleTracker();
    const first = lifecycle.begin('reused-user');
    expect(lifecycle.release('reused-user', first)).toBe(true);
    expect(lifecycle.size).toBe(0);

    const second = lifecycle.begin('reused-user');
    expect(second).not.toBe(first);
    expect(lifecycle.isCurrent('reused-user', first)).toBe(false);
    expect(lifecycle.release('reused-user', first)).toBe(false);
    expect(lifecycle.release('reused-user', second)).toBe(true);
    expect(lifecycle.size).toBe(0);
  });

  test('server publication is guarded by browser identity and lifecycle generation', () => {
    expect(serverSource).toContain('invalidateBrowserLifecycle();');
    expect(serverSource).toContain('activateBrowserLifecycle();');
    expect(serverSource).toMatch(
      /async function closeAllSessions[^]*?\{\n  invalidateBrowserLifecycle\(\);/,
    );
    expect(serverSource).toContain('!browserLifecycleClosing &&');
    expect(serverSource).toContain('browserLifecycle.isCurrent(browserGeneration) &&');
    expect(serverSource).toContain('browser === b &&');
    expect(serverSource).toContain('isStillCurrent: browserIsCurrent');
  });

  test('uses the compatibility guard before returning live and coalesced sessions', () => {
    expect(serverSource.match(/assertRequestProxyCompatible\(/g)?.length).toBeGreaterThanOrEqual(2);
  });

  test('reports whether the created tab is actually using a request proxy', () => {
    expect(serverSource).toContain('proxied: Boolean(session.requestProxy)');
  });
});
