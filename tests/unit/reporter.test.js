import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { anonymize, stackSignature, createReporter, createUrlAnonymizer, createTabHealthTracker } from '../../lib/reporter.js';

// ============================================================================
// Anonymization tests
// ============================================================================

describe('anonymize', () => {

  // ---- File paths ----

  it('strips Unix home directory paths', () => {
    const input = 'Error at /Users/pradeep/personal/camofox-browser/server.js:123:45';
    const result = anonymize(input);
    assert.ok(!result.includes('pradeep'), `leaked username: ${result}`);
    assert.ok(!result.includes('/Users/'), `leaked /Users/: ${result}`);
    assert.ok(result.includes('server.js'), 'should keep filename');
  });

  it('strips /home/ubuntu paths', () => {
    const input = 'at Object.<anonymous> (/home/ubuntu/app/lib/browser.js:456:12)';
    const result = anonymize(input);
    assert.ok(!result.includes('ubuntu'), `leaked username: ${result}`);
    assert.ok(result.includes('browser.js'), 'should keep filename');
  });

  it('strips Windows paths', () => {
    const input = 'at C:\\Users\\Administrator\\Desktop\\camofox\\server.js:99:10';
    const result = anonymize(input);
    assert.ok(!result.includes('Administrator'), `leaked username: ${result}`);
    assert.ok(result.includes('server.js'), 'should keep filename');
  });

  it('strips /root paths', () => {
    assert.ok(!anonymize('/root/.config/secrets/token.txt').includes('.config'));
  });

  it('strips /tmp paths', () => {
    const result = anonymize('Reading from /tmp/session-abc123/data.json');
    assert.ok(!result.includes('session-abc123'), `leaked session dir: ${result}`);
    assert.ok(result.includes('data.json'), 'should keep filename');
  });

  it('strips /data paths (Fly volumes)', () => {
    const result = anonymize('ENOENT /data/conversations/user_1234/ctx.db');
    assert.ok(!result.includes('user_1234'), `leaked user dir: ${result}`);
  });

  it('strips /app paths (Docker)', () => {
    const result = anonymize('Module not found: /app/node_modules/foo/dist/bar.js:10:5');
    assert.ok(!result.includes('/app/node_modules'), `leaked docker path: ${result}`);
  });

  // ---- URLs ----

  it('strips browsed URLs', () => {
    const input = 'Navigate failed for https://secret-internal.corp.example.com/admin/dashboard?token=abc123';
    const result = anonymize(input);
    assert.ok(!result.includes('secret-internal'), `leaked URL: ${result}`);
    assert.ok(!result.includes('corp.example.com'), `leaked host: ${result}`);
    assert.ok(result.includes('<https-url>'), 'should show placeholder');
  });

  it('strips WebSocket URLs', () => {
    const result = anonymize('Connection to wss://broker.internal:8443/ws failed');
    assert.ok(!result.includes('broker.internal'), `leaked ws host: ${result}`);
    assert.ok(result.includes('<wss-url>'), 'should show placeholder');
  });

  it('preserves safe GitHub URLs', () => {
    assert.ok(anonymize('Fetching https://api.github.com/repos/foo/bar').includes('api.github.com'));
  });

  it('preserves safe npm URLs', () => {
    assert.ok(anonymize('GET https://registry.npmjs.org/express 200').includes('registry.npmjs.org'));
  });

  // ---- IP addresses ----

  it('strips IPv4 addresses', () => {
    const result = anonymize('connect ECONNREFUSED 10.0.44.5:3001');
    assert.ok(!result.includes('10.0.44.5'), `leaked IP: ${result}`);
  });

  it('strips private IPs', () => {
    const result = anonymize('Proxy at 192.168.1.100:8080 failed');
    assert.ok(!result.includes('192.168.1.100'), `leaked IP: ${result}`);
  });

  it('redacts localhost 127.0.0.1', () => {
    assert.ok(!anonymize('Listening on 127.0.0.1:3000').includes('127.0.0.1'));
    assert.ok(anonymize('Listening on 127.0.0.1:3000').includes('<ip>'));
  });

  it('strips IPv6 addresses', () => {
    const result = anonymize('connect to 2001:0db8:85a3:0000:0000:8a2e:0370:7334 failed');
    assert.ok(!result.includes('2001:0db8'), `leaked IPv6: ${result}`);
  });

  it('strips IPv4-mapped IPv6', () => {
    const result = anonymize('from ::ffff:10.0.0.1');
    assert.ok(!result.includes('10.0.0.1'), `leaked mapped IP: ${result}`);
  });

  // ---- Tokens & secrets ----

  it('strips GitHub PATs (ghp_)', () => {
    const result = anonymize('Auth failed with ghp_ABCDEFghijklmnopqrstuvwxyz0123456789AB');
    assert.ok(!result.includes('ghp_'), `leaked PAT: ${result}`);
    assert.ok(result.includes('<token>'));
  });

  it('strips OpenAI keys (sk-)', () => {
    const result = anonymize('OPENAI_API_KEY=sk-proj-abcdefghijklmnopqrstuvwxyz12345678');
    assert.ok(!result.includes('sk-proj'), `leaked key: ${result}`);
  });

  it('strips Bearer tokens', () => {
    const result = anonymize('Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U');
    assert.ok(!result.includes('eyJ'), `leaked JWT: ${result}`);
    assert.ok(result.includes('<token>'));
  });

  it('strips Basic auth', () => {
    const result = anonymize('Authorization: Basic dXNlcm5hbWU6cGFzc3dvcmQ=');
    assert.ok(!result.includes('dXNlcm5hbWU'), `leaked basic auth: ${result}`);
  });

  it('strips AWS access keys', () => {
    const result = anonymize('key=AKIAIOSFODNN7EXAMPLE');
    assert.ok(!result.includes('AKIAIOSFODNN7'), `leaked AWS key: ${result}`);
  });

  it('strips long alphanumeric strings (40+ chars)', () => {
    const secret = 'aB'.repeat(25); // mixed case avoids hex ID pattern
    const result = anonymize(`Token: ${secret}`);
    assert.ok(!result.includes(secret), 'leaked long string');
    assert.ok(result.includes('<redacted>'));
  });

  it('strips long lowercase hex strings as IDs', () => {
    const secret = 'a'.repeat(50);
    const result = anonymize(`Token: ${secret}`);
    assert.ok(!result.includes(secret), 'leaked long string');
    assert.ok(result.includes('<id>'));
  });

  it('strips Slack tokens', () => {
    const result = anonymize('SLACK_TOKEN=xoxb-fake-test-token-placeholder');
    assert.ok(!result.includes('xoxb'), `leaked slack token: ${result}`);
  });

  // ---- Fly.io / Docker IDs ----

  it('strips Fly machine IDs (14-char hex)', () => {
    const result = anonymize('Machine e784079b295268 stopped');
    assert.ok(!result.includes('e784079b295268'), `leaked machine ID: ${result}`);
    assert.ok(result.includes('<id>'));
  });

  it('strips Docker container IDs', () => {
    const result = anonymize('Container abc123def45678 exited');
    assert.ok(!result.includes('abc123def45678'), `leaked container ID: ${result}`);
  });

  it('strips jo-machine app names', () => {
    const result = anonymize('Connecting to jo-machine-prod-1234');
    assert.ok(!result.includes('jo-machine-prod-1234'), `leaked app name: ${result}`);
    assert.ok(result.includes('<app>'));
  });

  it('strips jo-browser app name', () => {
    const result = anonymize('Deployed to jo-browser-staging');
    assert.ok(!result.includes('jo-browser'), `leaked app name: ${result}`);
  });

  // ---- Email addresses ----

  it('strips email addresses', () => {
    const result = anonymize('User pradeep@askjo.ai sent request');
    assert.ok(!result.includes('pradeep@'), `leaked email: ${result}`);
    assert.ok(result.includes('<email>'));
  });

  // ---- Env var assignments ----

  it('strips env var assignments', () => {
    const result = anonymize('SPRITE_TOKEN=abc123secretvalue456 in environment');
    assert.ok(!result.includes('abc123secret'), `leaked env value: ${result}`);
    assert.ok(result.includes('<env-var>'));
  });

  // ---- Proxy credentials ----

  it('strips proxy URLs with credentials', () => {
    const result = anonymize('Using proxy http://user:p4ssw0rd@proxy.corp.com:8080');
    assert.ok(!result.includes('p4ssw0rd'), `leaked proxy password: ${result}`);
    assert.ok(!result.includes('proxy.corp.com'), `leaked proxy host: ${result}`);
    assert.ok(result.includes('<proxy-url>'));
  });

  it('strips socks5 proxy credentials', () => {
    const result = anonymize('socks5://admin:secret@10.0.0.1:1080');
    assert.ok(!result.includes('admin:secret'), `leaked socks creds: ${result}`);
  });

  // ---- Connection errors with hostnames ----

  it('strips hostnames in ECONNREFUSED errors', () => {
    const result = anonymize('connect ECONNREFUSED internal.service.local:3001');
    assert.ok(!result.includes('internal.service.local'), `leaked hostname: ${result}`);
    assert.ok(result.includes('<host>'));
  });

  it('strips hostnames in ETIMEDOUT errors', () => {
    const result = anonymize('connect ETIMEDOUT api.private.svc:443');
    assert.ok(!result.includes('api.private.svc'), `leaked hostname: ${result}`);
  });

  // ---- Compound / real-world ----

  it('handles a realistic stack trace with multiple leak vectors', () => {
    const stack = `Error: Navigation timeout of 30000ms exceeded
    at navigate (/Users/pradeep/personal/camofox-browser/server.js:1500:15)
    at processRequest (/Users/pradeep/personal/camofox-browser/server.js:800:10)
    url: https://super-secret-dashboard.internal.corp.com/page?auth=ghp_XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX
    proxy: http://user:pass@192.168.1.50:8080
    machine: e784079b295268
    env: BROWSER_TOKEN=sk-abcdefghijklmnopqrstuvwxyz1234567890abcd`;
    const result = anonymize(stack);

    assert.ok(!result.includes('pradeep'), `leaked username: ${result}`);
    assert.ok(!result.includes('super-secret'), `leaked URL: ${result}`);
    assert.ok(!result.includes('ghp_'), `leaked PAT: ${result}`);
    assert.ok(!result.includes('user:pass'), `leaked proxy creds: ${result}`);
    assert.ok(!result.includes('192.168.1.50'), `leaked IP: ${result}`);
    assert.ok(!result.includes('e784079b295268'), `leaked machine ID: ${result}`);
    assert.ok(!result.includes('sk-abcdef'), `leaked token: ${result}`);
    assert.ok(result.includes('server.js'), 'should keep filename');
  });

  it('handles empty/null/undefined input gracefully', () => {
    assert.equal(anonymize(''), '');
    assert.equal(anonymize(null), '');
    assert.equal(anonymize(undefined), '');
  });

  it('preserves clean error messages', () => {
    const msg = 'TypeError: Cannot read properties of undefined';
    assert.equal(anonymize(msg), msg);
  });

  it('preserves standard error names', () => {
    const msg = 'TimeoutError: page.goto: Timeout 30000ms exceeded.';
    assert.equal(anonymize(msg), msg);
  });

  it('handles JSON-serialized error context', () => {
    const ctx = JSON.stringify({
      url: 'https://internal.corp.com/api',
      headers: { Authorization: 'Bearer eyJhbGciOiJSUzI1NiJ9.secretpayload' },
      proxy: 'socks5://admin:hunter2@10.0.0.5:1080',
    });
    const result = anonymize(ctx);
    assert.ok(!result.includes('internal.corp.com'));
    assert.ok(!result.includes('eyJ'));
    assert.ok(!result.includes('hunter2'));
    assert.ok(!result.includes('10.0.0.5'));
  });

  it('strips Sentry DSN URLs', () => {
    const result = anonymize('Sentry DSN: https://abc123def456@o123456.ingest.sentry.io/789');
    assert.ok(!result.includes('o123456'), `leaked sentry org: ${result}`);
  });

  it('preserves operation names and durations', () => {
    const msg = 'Operation "navigate" hung for 30s';
    assert.equal(anonymize(msg), msg);
  });

  it('does not create <token> from short strings after prefix', () => {
    const result = anonymize('key is sk-short');
    assert.equal(result, 'key is sk-short');
  });
});

// ============================================================================
// Stack signature / dedup tests
// ============================================================================

describe('stackSignature', () => {

  it('produces stable signatures for the same error', () => {
    const err = new Error('test');
    err.stack = `Error: test\n    at foo (/app/server.js:100:10)\n    at bar (/app/lib/utils.js:50:5)`;
    const sig1 = stackSignature('crash', err);
    const sig2 = stackSignature('crash', err);
    assert.equal(sig1, sig2);
  });

  it('produces different signatures for different locations', () => {
    const err1 = new Error('test');
    err1.stack = `Error: test\n    at foo (server.js:100:10)`;
    const err2 = new Error('test');
    err2.stack = `Error: test\n    at foo (server.js:200:10)`;
    assert.notEqual(stackSignature('crash', err1), stackSignature('crash', err2));
  });

  it('ignores column number differences (same file:line)', () => {
    const err1 = new Error('test');
    err1.stack = `Error: test\n    at foo (server.js:100:10)`;
    const err2 = new Error('test');
    err2.stack = `Error: test\n    at foo (server.js:100:55)`;
    assert.equal(stackSignature('crash', err1), stackSignature('crash', err2));
  });

  it('skips node_modules frames', () => {
    const err = new Error('test');
    err.stack = `Error: test
    at Object.something (node_modules/express/lib/router.js:50:10)
    at myHandler (server.js:300:15)`;
    const err2 = new Error('different message');
    err2.stack = `Error: different message
    at Object.other (node_modules/express/lib/router.js:99:10)
    at myHandler (server.js:300:15)`;
    assert.equal(stackSignature('crash', err), stackSignature('crash', err2));
  });

  it('handles errors without stack traces', () => {
    const sig = stackSignature('crash', { message: 'ENOMEM', name: 'SystemError' });
    assert.ok(typeof sig === 'string');
    assert.ok(sig.length === 8, 'should be 8-char hex');
  });

  it('returns 8-char hex string', () => {
    const sig = stackSignature('crash', new Error('any'));
    assert.match(sig, /^[0-9a-f]{8}$/);
  });
});

// ============================================================================
// Rate limiter tests
// ============================================================================

// Dummy creds so createReporter enters the enabled path (requires appId)
const TEST_CRASH_CONFIG = {
  crashReporterConfig: { appId: 'test-app', installationId: 'test-install', repo: 'test/repo', keyA: 'a', keyB: 'b' },
};

describe('rate limiting', () => {

  it('allows up to maxPerHour reports', () => {
    const reporter = createReporter({
      ...TEST_CRASH_CONFIG,
      crashReportEnabled: true,
      crashReportRepo: 'test/repo',
      crashReportRateLimit: 3,
    });
    const rl = reporter._rateLimiter;
    assert.ok(rl.tryAcquire());
    assert.ok(rl.tryAcquire());
    assert.ok(rl.tryAcquire());
    assert.ok(!rl.tryAcquire(), 'should reject 4th attempt');
    reporter.stop();
  });

  it('expires old entries after 1 hour', () => {
    const reporter = createReporter({
      ...TEST_CRASH_CONFIG,
      crashReportEnabled: true,
      crashReportRepo: 'test/repo',
      crashReportRateLimit: 2,
    });
    const rl = reporter._rateLimiter;
    rl.timestamps = [Date.now() - 3700_000, Date.now() - 3600_001];
    assert.ok(rl.tryAcquire(), 'old entries should be expired');
    assert.ok(rl.tryAcquire(), 'second should work too');
    assert.ok(!rl.tryAcquire(), 'third should fail');
    reporter.stop();
  });
});

// ============================================================================
// Reporter lifecycle tests
// ============================================================================

describe('createReporter', () => {

  it('returns no-op functions when disabled', async () => {
    const reporter = createReporter({
      crashReportEnabled: false,
      crashReportRepo: '',
    });
    await reporter.reportCrash(new Error('test'));
    await reporter.reportHang('navigate', 30000);
    await reporter.reportStuckLoop(60000);
    reporter.startWatchdog();
    reporter.stop();
  });

  it('exposes anonymize for testing even when disabled', () => {
    const reporter = createReporter({ crashReportEnabled: false });
    assert.equal(typeof reporter._anonymize, 'function');
    assert.ok(reporter._anonymize('/Users/foo/bar/baz.js').includes('baz.js'));
    assert.ok(!reporter._anonymize('/Users/foo/bar/baz.js').includes('foo'));
  });

  it('stop() resolves even with no in-flight reports', async () => {
    const reporter = createReporter({
      ...TEST_CRASH_CONFIG,
      crashReportEnabled: true,
      crashReportRepo: 'test/repo',
    });
    reporter.startWatchdog();
    const result = await reporter.stop();
    assert.ok(Array.isArray(result));
  });
});

// ============================================================================
// URL anonymizer tests
// ============================================================================

describe('createUrlAnonymizer', () => {

  it('preserves public infra domains verbatim', () => {
    const { anonymizeUrl } = createUrlAnonymizer();
    const result = anonymizeUrl('https://challenges.cloudflare.com/cdn-cgi/challenge-platform/main.js');
    assert.ok(result.includes('challenges.cloudflare.com'), `stripped public domain: ${result}`);
    assert.ok(!result.includes('main.js'), `leaked filename: ${result}`);
  });

  it('preserves major public sites verbatim (actionable reports)', () => {
    const { anonymizeUrl } = createUrlAnonymizer();
    const sites = [
      ['https://www.amazon.com/dp/B09876', 'amazon.com'],
      ['https://old.reddit.com/r/programming', 'old.reddit.com'],
      ['https://www.linkedin.com/in/someone', 'linkedin.com'],
      ['https://twitter.com/user/status/123', 'twitter.com'],
      ['https://www.facebook.com/profile', 'facebook.com'],
      ['https://www.instagram.com/p/abc', 'instagram.com'],
      ['https://open.spotify.com/track/123', 'open.spotify.com'],
      ['https://discord.com/channels/123', 'discord.com'],
      ['https://www.nytimes.com/2026/article', 'nytimes.com'],
      ['https://stackoverflow.com/questions/123', 'stackoverflow.com'],
    ];
    for (const [url, expectedHost] of sites) {
      const result = anonymizeUrl(url);
      assert.ok(result.includes(expectedHost), `hashed public site ${expectedHost}: ${result}`);
      // paths should still be stripped
      assert.ok(!result.includes('someone') && !result.includes('programming'),
        `leaked path for ${expectedHost}: ${result}`);
    }
  });

  it('preserves scraping targets and prediction markets verbatim', () => {
    const { anonymizeUrl } = createUrlAnonymizer();
    const sites = [
      ['https://polymarket.com/event/some-market-slug', 'polymarket.com'],
      ['https://kalshi.com/markets/some-event', 'kalshi.com'],
      ['https://www.zillow.com/homedetails/123', 'zillow.com'],
      ['https://www.indeed.com/viewjob?jk=abc123', 'indeed.com'],
      ['https://www.airbnb.com/rooms/12345', 'airbnb.com'],
      ['https://www.tradingview.com/chart/BTCUSD', 'tradingview.com'],
      ['https://www.coinbase.com/price/bitcoin', 'coinbase.com'],
      ['https://etherscan.io/tx/0xabc', 'etherscan.io'],
      ['https://openai.com/api/docs', 'openai.com'],
      ['https://news.ycombinator.com/item?id=123', 'news.ycombinator.com'],
    ];
    for (const [url, expectedHost] of sites) {
      const result = anonymizeUrl(url);
      assert.ok(result.includes(expectedHost), `hashed public site ${expectedHost}: ${result}`);
    }
  });

  it('hashes private domains', () => {
    const { anonymizeUrl } = createUrlAnonymizer();
    const result = anonymizeUrl('https://internal-dashboard.corp.example.com/admin/users');
    assert.ok(!result.includes('internal-dashboard'), `leaked hostname: ${result}`);
    assert.ok(!result.includes('corp.example.com'), `leaked domain: ${result}`);
    assert.ok(result.startsWith('https://site-'), 'should hash domain');
  });

  it('strips all path segments, preserves depth', () => {
    const { anonymizeUrl } = createUrlAnonymizer();
    const result = anonymizeUrl('https://example.com/patients/john-doe/records/2024');
    assert.ok(!result.includes('patients'), `leaked path: ${result}`);
    assert.ok(!result.includes('john-doe'), `leaked PII: ${result}`);
    // Should have 4 bullet points for 4 segments
    const bullets = (result.match(/\u2022/g) || []).length;
    assert.equal(bullets, 4, `expected 4 path segments, got ${bullets}: ${result}`);
  });

  it('strips query param names and values, preserves count', () => {
    const { anonymizeUrl } = createUrlAnonymizer();
    const result = anonymizeUrl('https://example.com/page?email=user@test.com&token=abc123&view=full');
    assert.ok(!result.includes('email'), `leaked param name: ${result}`);
    assert.ok(!result.includes('user@'), `leaked param value: ${result}`);
    assert.ok(result.includes('?[3]'), `should show param count: ${result}`);
  });

  it('notes fragment presence without content', () => {
    const { anonymizeUrl } = createUrlAnonymizer();
    const result = anonymizeUrl('https://example.com/page#secret-section');
    assert.ok(!result.includes('secret-section'), `leaked fragment: ${result}`);
    assert.ok(result.includes('#[frag]'), `should note fragment: ${result}`);
  });

  it('preserves non-standard ports', () => {
    const { anonymizeUrl } = createUrlAnonymizer();
    const result = anonymizeUrl('https://example.com:8443/api');
    assert.ok(result.includes(':8443'), `lost port: ${result}`);
  });

  it('same domain produces same hash within one anonymizer', () => {
    const { anonymizeUrl } = createUrlAnonymizer();
    const r1 = anonymizeUrl('https://mysite.com/page1');
    const r2 = anonymizeUrl('https://mysite.com/page2');
    // Extract the site-XXXXXXXX part
    const hash1 = r1.match(/site-[a-f0-9]+/)?.[0];
    const hash2 = r2.match(/site-[a-f0-9]+/)?.[0];
    assert.equal(hash1, hash2, 'same domain should produce same hash');
  });

  it('different anonymizers produce SAME hashes (stable key, cross-report correlation)', () => {
    const a1 = createUrlAnonymizer();
    const a2 = createUrlAnonymizer();
    const r1 = a1.anonymizeUrl('https://mysite.com/');
    const r2 = a2.anonymizeUrl('https://mysite.com/');
    const hash1 = r1.match(/site-[a-f0-9]+/)?.[0];
    const hash2 = r2.match(/site-[a-f0-9]+/)?.[0];
    assert.equal(hash1, hash2, 'stable key should produce same hash across reports');
  });

  it('hashes IP addresses', () => {
    const { anonymizeUrl } = createUrlAnonymizer();
    const result = anonymizeUrl('http://192.168.1.100:8080/api');
    assert.ok(!result.includes('192.168'), `leaked IP: ${result}`);
    assert.ok(result.includes('site-'), 'should hash IP');
  });

  it('redacts localhost', () => {
    const { anonymizeUrl } = createUrlAnonymizer();
    assert.ok(!anonymizeUrl('http://localhost:3000/test').includes('localhost'));
    assert.ok(!anonymizeUrl('http://127.0.0.1:3000/test').includes('127.0.0.1'));
  });

  it('handles data/blob/javascript URIs', () => {
    const { anonymizeUrl } = createUrlAnonymizer();
    assert.equal(anonymizeUrl('data:text/html,<h1>secret</h1>'), '[data-uri]');
    assert.equal(anonymizeUrl('blob:https://example.com/abc'), '[blob-uri]');
    assert.equal(anonymizeUrl('javascript:alert(1)'), '[javascript-uri]');
  });

  it('handles empty/null/invalid input', () => {
    const { anonymizeUrl } = createUrlAnonymizer();
    assert.equal(anonymizeUrl(''), '[empty]');
    assert.equal(anonymizeUrl(null), '[empty]');
    assert.equal(anonymizeUrl('not-a-url'), '[invalid-url]');
  });

  it('anonymizes redirect chains with correlation', () => {
    const { anonymizeChain } = createUrlAnonymizer();
    const chain = [
      'https://mysite.com/login',
      'https://accounts.google.com/o/oauth2/auth?client_id=xxx',
      'https://mysite.com/callback?code=yyy',
    ];
    const result = anonymizeChain(chain);
    assert.ok(result.includes('accounts.google.com'), 'should preserve Google');
    assert.ok(!result.includes('mysite.com'), `leaked domain: ${result}`);
    assert.ok(result.includes('\u2192'), 'should have arrow separators');
    // Both mysite.com entries should have same hash
    const hashes = result.match(/site-[a-f0-9]+/g);
    assert.equal(hashes[0], hashes[1], 'same domain should correlate in chain');
  });

  it('never leaks multi-tenant hosting domains', () => {
    const { anonymizeUrl } = createUrlAnonymizer();
    // These should all be hashed, not preserved
    for (const url of [
      'https://myapp.herokuapp.com/',
      'https://myapp.vercel.app/',
      'https://myapp.netlify.app/',
      'https://myapp.fly.dev/',
    ]) {
      const result = anonymizeUrl(url);
      assert.ok(result.includes('site-'), `should hash ${url}: ${result}`);
    }
  });

  it('strips auth credentials from URLs', () => {
    const { anonymizeUrl } = createUrlAnonymizer();
    const result = anonymizeUrl('https://admin:secret@example.com/dashboard');
    assert.ok(!result.includes('admin'), `leaked username: ${result}`);
    assert.ok(!result.includes('secret'), `leaked password: ${result}`);
  });
});
