import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { REQUEST_PROXY_RECOVERY_REASONS } from '../../lib/request-proxy.js';

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

  test('does not let an in-flight close delete a replacement session', () => {
    expect(serverSource).toContain('if (sessions.get(key) === session) sessions.delete(key);');
  });

  test('uses the compatibility guard before returning live and coalesced sessions', () => {
    expect(serverSource.match(/assertRequestProxyCompatible\(/g)?.length).toBeGreaterThanOrEqual(2);
  });

  test('reports whether the created tab is actually using a request proxy', () => {
    expect(serverSource).toContain('proxied: Boolean(session.requestProxy)');
  });
});
