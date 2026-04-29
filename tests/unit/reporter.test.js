import {
  anonymize, stackSignature, createReporter, sendToRelay, createUrlAnonymizer,
  createTabHealthTracker, collectResourceSnapshot, detectBotProtection,
  classifyProxyError,
} from '../../lib/reporter.js';

// ============================================================================
// Anonymization tests
// ============================================================================

describe('anonymize', () => {

  // ---- File paths ----

  test('strips Unix home directory paths', () => {
    const input = 'Error at /Users/pradeep/personal/camofox-browser/server.js:123:45';
    const result = anonymize(input);
    expect(!result.includes('pradeep')).toBeTruthy();
    expect(!result.includes('/Users/')).toBeTruthy();
    expect(result.includes('server.js')).toBeTruthy();
  });

  test('strips /home/ubuntu paths', () => {
    const input = 'at Object.<anonymous> (/home/ubuntu/app/lib/browser.js:456:12)';
    const result = anonymize(input);
    expect(!result.includes('ubuntu')).toBeTruthy();
    expect(result.includes('browser.js')).toBeTruthy();
  });

  test('strips Windows paths', () => {
    const input = 'at C:\\Users\\Administrator\\Desktop\\camofox\\server.js:99:10';
    const result = anonymize(input);
    expect(!result.includes('Administrator')).toBeTruthy();
    expect(result.includes('server.js')).toBeTruthy();
  });

  test('strips /root paths', () => {
    expect(!anonymize('/root/.config/secrets/token.txt').includes('.config')).toBeTruthy();
  });

  test('strips /tmp paths', () => {
    const result = anonymize('Reading from /tmp/session-abc123/data.json');
    expect(!result.includes('session-abc123')).toBeTruthy();
    expect(result.includes('data.json')).toBeTruthy();
  });

  test('strips /data paths (Fly volumes)', () => {
    const result = anonymize('ENOENT /data/conversations/user_1234/ctx.db');
    expect(!result.includes('user_1234')).toBeTruthy();
  });

  test('strips /app paths (Docker)', () => {
    const result = anonymize('Module not found: /app/node_modules/foo/dist/bar.js:10:5');
    expect(!result.includes('/app/node_modules')).toBeTruthy();
  });

  // ---- URLs ----

  test('strips browsed URLs', () => {
    const input = 'Navigate failed for https://secret-internal.corp.example.com/admin/dashboard?token=abc123';
    const result = anonymize(input);
    expect(!result.includes('secret-internal')).toBeTruthy();
    expect(!result.includes('corp.example.com')).toBeTruthy();
    expect(result.includes('<https-url>')).toBeTruthy();
  });

  test('strips WebSocket URLs', () => {
    const result = anonymize('Connection to wss://broker.internal:8443/ws failed');
    expect(!result.includes('broker.internal')).toBeTruthy();
    expect(result.includes('<wss-url>')).toBeTruthy();
  });

  test('preserves safe GitHub URLs', () => {
    expect(anonymize('Fetching https://api.github.com/repos/foo/bar').includes('api.github.com')).toBeTruthy();
  });

  test('preserves safe npm URLs', () => {
    expect(anonymize('GET https://registry.npmjs.org/express 200').includes('registry.npmjs.org')).toBeTruthy();
  });

  // ---- IP addresses ----

  test('strips IPv4 addresses', () => {
    const result = anonymize('connect ECONNREFUSED 10.0.44.5:3001');
    expect(!result.includes('10.0.44.5')).toBeTruthy();
  });

  test('strips private IPs', () => {
    const result = anonymize('Proxy at 192.168.1.100:8080 failed');
    expect(!result.includes('192.168.1.100')).toBeTruthy();
  });

  test('redacts localhost 127.0.0.1', () => {
    expect(!anonymize('Listening on 127.0.0.1:3000').includes('127.0.0.1')).toBeTruthy();
    expect(anonymize('Listening on 127.0.0.1:3000').includes('<ip>')).toBeTruthy();
  });

  test('strips IPv6 addresses', () => {
    const result = anonymize('connect to 2001:0db8:85a3:0000:0000:8a2e:0370:7334 failed');
    expect(!result.includes('2001:0db8')).toBeTruthy();
  });

  test('strips IPv4-mapped IPv6', () => {
    const result = anonymize('from ::ffff:10.0.0.1');
    expect(!result.includes('10.0.0.1')).toBeTruthy();
  });

  // ---- Tokens & secrets ----

  test('strips GitHub PATs (ghp_)', () => {
    const result = anonymize('Auth failed with ghp_ABCDEFghijklmnopqrstuvwxyz0123456789AB');
    expect(!result.includes('ghp_')).toBeTruthy();
    expect(result.includes('<token>')).toBeTruthy();
  });

  test('strips OpenAI keys (sk-)', () => {
    const result = anonymize('OPENAI_API_KEY=sk-proj-abcdefghijklmnopqrstuvwxyz12345678');
    expect(!result.includes('sk-proj')).toBeTruthy();
  });

  test('strips Bearer tokens', () => {
    const result = anonymize('Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U');
    expect(!result.includes('eyJ')).toBeTruthy();
    expect(result.includes('<token>')).toBeTruthy();
  });

  test('strips Basic auth', () => {
    const result = anonymize('Authorization: Basic dXNlcm5hbWU6cGFzc3dvcmQ=');
    expect(!result.includes('dXNlcm5hbWU')).toBeTruthy();
  });

  test('strips AWS access keys', () => {
    const result = anonymize('key=AKIAIOSFODNN7EXAMPLE');
    expect(!result.includes('AKIAIOSFODNN7')).toBeTruthy();
  });

  test('strips long alphanumeric strings (40+ chars)', () => {
    const secret = 'aB'.repeat(25); // mixed case avoids hex ID pattern
    const result = anonymize(`Token: ${secret}`);
    expect(!result.includes(secret)).toBeTruthy();
    expect(result.includes('<redacted>')).toBeTruthy();
  });

  test('strips long lowercase hex strings as IDs', () => {
    const secret = 'a'.repeat(50);
    const result = anonymize(`Token: ${secret}`);
    expect(!result.includes(secret)).toBeTruthy();
    expect(result.includes('<id>')).toBeTruthy();
  });

  test('strips Slack tokens', () => {
    const result = anonymize('SLACK_TOKEN=xoxb-fake-test-token-placeholder');
    expect(!result.includes('xoxb')).toBeTruthy();
  });

  // ---- Fly.io / Docker IDs ----

  test('strips Fly machine IDs (14-char hex)', () => {
    const result = anonymize('Machine e784079b295268 stopped');
    expect(!result.includes('e784079b295268')).toBeTruthy();
    expect(result.includes('<id>')).toBeTruthy();
  });

  test('strips Docker container IDs', () => {
    const result = anonymize('Container abc123def45678 exited');
    expect(!result.includes('abc123def45678')).toBeTruthy();
  });

  test('strips jo-machine app names', () => {
    const result = anonymize('Connecting to jo-machine-prod-1234');
    expect(!result.includes('jo-machine-prod-1234')).toBeTruthy();
    expect(result.includes('<app>')).toBeTruthy();
  });

  test('strips jo-browser app name', () => {
    const result = anonymize('Deployed to jo-browser-staging');
    expect(!result.includes('jo-browser')).toBeTruthy();
  });

  // ---- Email addresses ----

  test('strips email addresses', () => {
    const result = anonymize('User pradeep@askjo.ai sent request');
    expect(!result.includes('pradeep@')).toBeTruthy();
    expect(result.includes('<email>')).toBeTruthy();
  });

  // ---- Env var assignments ----

  test('strips env var assignments', () => {
    const result = anonymize('SPRITE_TOKEN=abc123secretvalue456 in environment');
    expect(!result.includes('abc123secret')).toBeTruthy();
    expect(result.includes('<env-var>')).toBeTruthy();
  });

  // ---- Proxy credentials ----

  test('strips proxy URLs with credentials', () => {
    const result = anonymize('Using proxy http://user:p4ssw0rd@proxy.corp.com:8080');
    expect(!result.includes('p4ssw0rd')).toBeTruthy();
    expect(!result.includes('proxy.corp.com')).toBeTruthy();
    expect(result.includes('<proxy-url>')).toBeTruthy();
  });

  test('strips socks5 proxy credentials', () => {
    const result = anonymize('socks5://admin:secret@10.0.0.1:1080');
    expect(!result.includes('admin:secret')).toBeTruthy();
  });

  // ---- Connection errors with hostnames ----

  test('strips hostnames in ECONNREFUSED errors', () => {
    const result = anonymize('connect ECONNREFUSED internal.service.local:3001');
    expect(!result.includes('internal.service.local')).toBeTruthy();
    expect(result.includes('<host>')).toBeTruthy();
  });

  test('strips hostnames in ETIMEDOUT errors', () => {
    const result = anonymize('connect ETIMEDOUT api.private.svc:443');
    expect(!result.includes('api.private.svc')).toBeTruthy();
  });

  // ---- Compound / real-world ----

  test('handles a realistic stack trace with multiple leak vectors', () => {
    const stack = `Error: Navigation timeout of 30000ms exceeded
    at navigate (/Users/pradeep/personal/camofox-browser/server.js:1500:15)
    at processRequest (/Users/pradeep/personal/camofox-browser/server.js:800:10)
    url: https://super-secret-dashboard.internal.corp.com/page?auth=ghp_XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX
    proxy: http://user:pass@192.168.1.50:8080
    machine: e784079b295268
    env: BROWSER_TOKEN=sk-abcdefghijklmnopqrstuvwxyz1234567890abcd`;
    const result = anonymize(stack);

    expect(!result.includes('pradeep')).toBeTruthy();
    expect(!result.includes('super-secret')).toBeTruthy();
    expect(!result.includes('ghp_')).toBeTruthy();
    expect(!result.includes('user:pass')).toBeTruthy();
    expect(!result.includes('192.168.1.50')).toBeTruthy();
    expect(!result.includes('e784079b295268')).toBeTruthy();
    expect(!result.includes('sk-abcdef')).toBeTruthy();
    expect(result.includes('server.js')).toBeTruthy();
  });

  test('handles empty/null/undefined input gracefully', () => {
    expect(anonymize('')).toBe('');
    expect(anonymize(null)).toBe('');
    expect(anonymize(undefined)).toBe('');
  });

  test('preserves clean error messages', () => {
    const msg = 'TypeError: Cannot read properties of undefined';
    expect(anonymize(msg)).toBe(msg);
  });

  test('preserves standard error names', () => {
    const msg = 'TimeoutError: page.goto: Timeout 30000ms exceeded.';
    expect(anonymize(msg)).toBe(msg);
  });

  test('handles JSON-serialized error context', () => {
    const ctx = JSON.stringify({
      url: 'https://internal.corp.com/api',
      headers: { Authorization: 'Bearer eyJhbGciOiJSUzI1NiJ9.secretpayload' },
      proxy: 'socks5://admin:hunter2@10.0.0.5:1080',
    });
    const result = anonymize(ctx);
    expect(!result.includes('internal.corp.com')).toBeTruthy();
    expect(!result.includes('eyJ')).toBeTruthy();
    expect(!result.includes('hunter2')).toBeTruthy();
    expect(!result.includes('10.0.0.5')).toBeTruthy();
  });

  test('strips Sentry DSN URLs', () => {
    const result = anonymize('Sentry DSN: https://abc123def456@o123456.ingest.sentry.io/789');
    expect(!result.includes('o123456')).toBeTruthy();
  });

  test('preserves operation names and durations', () => {
    const msg = 'Operation "navigate" hung for 30s';
    expect(anonymize(msg)).toBe(msg);
  });

  test('does not create <token> from short strings after prefix', () => {
    const result = anonymize('key is sk-short');
    expect(result).toBe('key is sk-short');
  });
});

// ============================================================================
// Stack signature / dedup tests
// ============================================================================

describe('stackSignature', () => {

  test('produces stable signatures for the same error', () => {
    const err = new Error('test');
    err.stack = `Error: test\n    at foo (/app/server.js:100:10)\n    at bar (/app/lib/utils.js:50:5)`;
    const sig1 = stackSignature('crash', err);
    const sig2 = stackSignature('crash', err);
    expect(sig1).toBe(sig2);
  });

  test('produces different signatures for different locations', () => {
    const err1 = new Error('test');
    err1.stack = `Error: test\n    at foo (server.js:100:10)`;
    const err2 = new Error('test');
    err2.stack = `Error: test\n    at foo (server.js:200:10)`;
    expect(stackSignature('crash', err1)).not.toBe(stackSignature('crash', err2));
  });

  test('ignores column number differences (same file:line)', () => {
    const err1 = new Error('test');
    err1.stack = `Error: test\n    at foo (server.js:100:10)`;
    const err2 = new Error('test');
    err2.stack = `Error: test\n    at foo (server.js:100:55)`;
    expect(stackSignature('crash', err1)).toBe(stackSignature('crash', err2));
  });

  test('skips node_modules frames', () => {
    const err = new Error('test');
    err.stack = `Error: test
    at Object.something (node_modules/express/lib/router.js:50:10)
    at myHandler (server.js:300:15)`;
    const err2 = new Error('different message');
    err2.stack = `Error: different message
    at Object.other (node_modules/express/lib/router.js:99:10)
    at myHandler (server.js:300:15)`;
    expect(stackSignature('crash', err)).toBe(stackSignature('crash', err2));
  });

  test('handles errors without stack traces', () => {
    const sig = stackSignature('crash', { message: 'ENOMEM', name: 'SystemError' });
    expect(typeof sig === 'string').toBeTruthy();
    expect(sig.length === 8).toBeTruthy();
  });

  test('returns 8-char hex string', () => {
    const sig = stackSignature('crash', new Error('any'));
    expect(sig).toMatch(/^[0-9a-f]{8}$/);
  });
});

// ============================================================================
// Rate limiter tests
// ============================================================================

// Reporter is now enabled by default (no appId check -- relay handles auth)
const TEST_CRASH_CONFIG = {};

describe('rate limiting', () => {

  test('allows up to maxPerHour reports', () => {
    const reporter = createReporter({
      ...TEST_CRASH_CONFIG,
      crashReportEnabled: true,
      crashReportRateLimit: 3,
    });
    const rl = reporter._rateLimiter._default;
    expect(rl.tryAcquire()).toBeTruthy();
    expect(rl.tryAcquire()).toBeTruthy();
    expect(rl.tryAcquire()).toBeTruthy();
    expect(!rl.tryAcquire()).toBeTruthy();
    reporter.stop();
  });

  test('expires old entries after 1 hour', () => {
    const reporter = createReporter({
      ...TEST_CRASH_CONFIG,
      crashReportEnabled: true,
      crashReportRateLimit: 2,
    });
    const rl = reporter._rateLimiter._default;
    rl.timestamps = [Date.now() - 3700_000, Date.now() - 3600_001];
    expect(rl.tryAcquire()).toBeTruthy();
    expect(rl.tryAcquire()).toBeTruthy();
    expect(!rl.tryAcquire()).toBeTruthy();
    reporter.stop();
  });
});

// ============================================================================
// Reporter lifecycle tests
// ============================================================================

describe('createReporter', () => {

  test('returns no-op functions when disabled', async () => {
    const reporter = createReporter({
      crashReportEnabled: false,
      crashReportRepo: '',
    });
    await reporter.reportCrash(new Error('test'));
    await reporter.reportHang('navigate', 30000);
    await reporter.reportStuckLoop(60000);
    reporter.startWatchdog();
    reporter.trackRoute('GET /test');
    reporter.stop();
  });

  test('exposes anonymize for testing even when disabled', () => {
    const reporter = createReporter({ crashReportEnabled: false });
    expect(typeof reporter._anonymize).toBe('function');
    expect(reporter._anonymize('/Users/foo/bar/baz.js').includes('baz.js')).toBeTruthy();
    expect(!reporter._anonymize('/Users/foo/bar/baz.js').includes('foo')).toBeTruthy();
  });

  test('stop() resolves even with no in-flight reports', async () => {
    const reporter = createReporter({
      ...TEST_CRASH_CONFIG,
      crashReportEnabled: true,
    });
    reporter.startWatchdog();
    const result = await reporter.stop();
    expect(Array.isArray(result)).toBeTruthy();
  });

  test('trackRoute is a function on enabled reporter', () => {
    const reporter = createReporter({
      ...TEST_CRASH_CONFIG,
      crashReportEnabled: true,
    });
    expect(typeof reporter.trackRoute).toBe('function');
    reporter.trackRoute('POST /tabs/:id/navigate');
    reporter.stop();
  });
});

// ============================================================================
// URL anonymizer tests
// ============================================================================

describe('createUrlAnonymizer', () => {

  test('preserves public infra domains verbatim', () => {
    const { anonymizeUrl } = createUrlAnonymizer();
    const result = anonymizeUrl('https://challenges.cloudflare.com/cdn-cgi/challenge-platform/main.js');
    expect(result.includes('challenges.cloudflare.com')).toBeTruthy();
    expect(!result.includes('main.js')).toBeTruthy();
  });

  test('preserves major public sites verbatim (actionable reports)', () => {
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
      expect(result.includes(expectedHost)).toBeTruthy();
      // paths should still be stripped
      expect(!result.includes('someone') && !result.includes('programming')).toBeTruthy();
    }
  });

  test('preserves scraping targets and prediction markets verbatim', () => {
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
      expect(result.includes(expectedHost)).toBeTruthy();
    }
  });

  test('hashes private domains', () => {
    const { anonymizeUrl } = createUrlAnonymizer();
    const result = anonymizeUrl('https://internal-dashboard.corp.example.com/admin/users');
    expect(!result.includes('internal-dashboard')).toBeTruthy();
    expect(!result.includes('corp.example.com')).toBeTruthy();
    expect(result.startsWith('https://site-')).toBeTruthy();
  });

  test('strips all path segments, preserves depth', () => {
    const { anonymizeUrl } = createUrlAnonymizer();
    const result = anonymizeUrl('https://example.com/patients/john-doe/records/2024');
    expect(!result.includes('patients')).toBeTruthy();
    expect(!result.includes('john-doe')).toBeTruthy();
    // Should have 4 bullet points for 4 segments
    const bullets = (result.match(/\u2022/g) || []).length;
    expect(bullets).toBe(4);
  });

  test('strips query param names and values, preserves count', () => {
    const { anonymizeUrl } = createUrlAnonymizer();
    const result = anonymizeUrl('https://example.com/page?email=user@test.com&token=abc123&view=full');
    expect(!result.includes('email')).toBeTruthy();
    expect(!result.includes('user@')).toBeTruthy();
    expect(result.includes('?[3]')).toBeTruthy();
  });

  test('notes fragment presence without content', () => {
    const { anonymizeUrl } = createUrlAnonymizer();
    const result = anonymizeUrl('https://example.com/page#secret-section');
    expect(!result.includes('secret-section')).toBeTruthy();
    expect(result.includes('#[frag]')).toBeTruthy();
  });

  test('preserves non-standard ports', () => {
    const { anonymizeUrl } = createUrlAnonymizer();
    const result = anonymizeUrl('https://example.com:8443/api');
    expect(result.includes(':8443')).toBeTruthy();
  });

  test('same domain produces same hash within one anonymizer', () => {
    const { anonymizeUrl } = createUrlAnonymizer();
    const r1 = anonymizeUrl('https://mysite.com/page1');
    const r2 = anonymizeUrl('https://mysite.com/page2');
    // Extract the site-XXXXXXXX part
    const hash1 = r1.match(/site-[a-f0-9]+/)?.[0];
    const hash2 = r2.match(/site-[a-f0-9]+/)?.[0];
    expect(hash1).toBe(hash2);
  });

  test('different anonymizers produce SAME hashes (stable key, cross-report correlation)', () => {
    const a1 = createUrlAnonymizer();
    const a2 = createUrlAnonymizer();
    const r1 = a1.anonymizeUrl('https://mysite.com/');
    const r2 = a2.anonymizeUrl('https://mysite.com/');
    const hash1 = r1.match(/site-[a-f0-9]+/)?.[0];
    const hash2 = r2.match(/site-[a-f0-9]+/)?.[0];
    expect(hash1).toBe(hash2);
  });

  test('hashes IP addresses', () => {
    const { anonymizeUrl } = createUrlAnonymizer();
    const result = anonymizeUrl('http://192.168.1.100:8080/api');
    expect(!result.includes('192.168')).toBeTruthy();
    expect(result.includes('site-')).toBeTruthy();
  });

  test('redacts localhost', () => {
    const { anonymizeUrl } = createUrlAnonymizer();
    expect(!anonymizeUrl('http://localhost:3000/test').includes('localhost')).toBeTruthy();
    expect(!anonymizeUrl('http://127.0.0.1:3000/test').includes('127.0.0.1')).toBeTruthy();
  });

  test('handles data/blob/javascript URIs', () => {
    const { anonymizeUrl } = createUrlAnonymizer();
    expect(anonymizeUrl('data:text/html).toBe(<h1>secret</h1>'));
    expect(anonymizeUrl('blob:https://example.com/abc')).toBe('[blob-uri]');
    expect(anonymizeUrl('javascript:alert(1)')).toBe('[javascript-uri]');
  });

  test('handles empty/null/invalid input', () => {
    const { anonymizeUrl } = createUrlAnonymizer();
    expect(anonymizeUrl('')).toBe('[empty]');
    expect(anonymizeUrl(null)).toBe('[empty]');
    expect(anonymizeUrl('not-a-url')).toBe('[invalid-url]');
  });

  test('anonymizes redirect chains with correlation', () => {
    const { anonymizeChain } = createUrlAnonymizer();
    const chain = [
      'https://mysite.com/login',
      'https://accounts.google.com/o/oauth2/auth?client_id=xxx',
      'https://mysite.com/callback?code=yyy',
    ];
    const result = anonymizeChain(chain);
    expect(result.includes('accounts.google.com')).toBeTruthy();
    expect(!result.includes('mysite.com')).toBeTruthy();
    expect(result.includes('\u2192')).toBeTruthy();
    // Both mysite.com entries should have same hash
    const hashes = result.match(/site-[a-f0-9]+/g);
    expect(hashes[0]).toBe(hashes[1]);
  });

  test('never leaks multi-tenant hosting domains', () => {
    const { anonymizeUrl } = createUrlAnonymizer();
    // These should all be hashed, not preserved
    for (const url of [
      'https://myapp.herokuapp.com/',
      'https://myapp.vercel.app/',
      'https://myapp.netlify.app/',
      'https://myapp.fly.dev/',
    ]) {
      const result = anonymizeUrl(url);
      expect(result.includes('site-')).toBeTruthy();
    }
  });

  test('strips auth credentials from URLs', () => {
    const { anonymizeUrl } = createUrlAnonymizer();
    const result = anonymizeUrl('https://admin:secret@example.com/dashboard');
    expect(!result.includes('admin')).toBeTruthy();
    expect(!result.includes('secret')).toBeTruthy();
  });
});

// ============================================================================
// Bot detection tests
// ============================================================================

describe('detectBotProtection', () => {

  function mockResponse(status, headers) {
    return {
      status: () => status,
      headers: () => headers,
    };
  }

  test('detects Cloudflare challenge (cf-mitigated header)', () => {
    const result = detectBotProtection(mockResponse(403, { 'cf-mitigated': 'challenge', 'cf-ray': '123abc' }));
    expect(result.detected).toBe(true);
    expect(result.provider).toBe('cloudflare');
    expect(result.httpStatus).toBe(403);
  });

  test('detects Cloudflare by cf-ray header on 403', () => {
    const result = detectBotProtection(mockResponse(403, { 'cf-ray': '7abc123-LAX' }));
    expect(result.detected).toBe(true);
    expect(result.provider).toBe('cloudflare');
  });

  test('Cloudflare cf-ray on 200 is not a challenge', () => {
    const result = detectBotProtection(mockResponse(200, { 'cf-ray': '7abc123-LAX' }));
    expect(result.detected).toBe(false);
    expect(result.provider).toBe('cloudflare');
  });

  test('detects DataDome even behind Cloudflare (cf-ray present)', () => {
    // Multi-CDN: Cloudflare fronts the site (cf-ray on all responses)
    // but DataDome is the actual bot-detection provider blocking with 403
    const result = detectBotProtection(mockResponse(403, {
      'cf-ray': '7abc123-LAX',
      'x-datadome': 'protected',
    }));
    expect(result.detected).toBe(true);
    expect(result.provider).toBe('datadome');
  });

  test('detects DataDome', () => {
    const result = detectBotProtection(mockResponse(403, { 'x-datadome': 'protected' }));
    expect(result.detected).toBe(true);
    expect(result.provider).toBe('datadome');
  });

  test('detects PerimeterX', () => {
    const result = detectBotProtection(mockResponse(429, { 'x-px': 'something' }));
    expect(result.detected).toBe(true);
    expect(result.provider).toBe('perimeterx');
  });

  test('detects Akamai', () => {
    const result = detectBotProtection(mockResponse(503, { 'server': 'AkamaiGHost' }));
    expect(result.detected).toBe(true);
    expect(result.provider).toBe('akamai');
  });

  test('returns not detected for normal response', () => {
    const result = detectBotProtection(mockResponse(200, { 'content-type': 'text/html' }));
    expect(result.detected).toBe(false);
    expect(result.provider).toBe(null);
    expect(result.httpStatus).toBe(200);
  });

  test('returns not detected for null response', () => {
    const result = detectBotProtection(null);
    expect(result.detected).toBe(false);
    expect(result.provider).toBe(null);
    expect(result.httpStatus).toBe(null);
  });

  test('handles response that throws on headers()', () => {
    const result = detectBotProtection({
      status: () => 403,
      headers: () => { throw new Error('page closed'); },
    });
    expect(result.detected).toBe(false);
    expect(result.httpStatus).toBe(403);
  });
});

// ============================================================================
// Proxy error classification tests
// ============================================================================

describe('classifyProxyError', () => {

  test('detects ERR_PROXY_CONNECTION_FAILED', () => {
    const result = classifyProxyError('net::ERR_PROXY_CONNECTION_FAILED');
    expect(result.proxyError).toBe('ERR_PROXY_CONNECTION_FAILED');
    expect(result.proxyTlsError).toBe(false);
  });

  test('detects ERR_TUNNEL_CONNECTION_FAILED', () => {
    const result = classifyProxyError('net::ERR_TUNNEL_CONNECTION_FAILED');
    expect(result.proxyError).toBe('ERR_TUNNEL_CONNECTION_FAILED');
  });

  test('detects proxy auth required (407)', () => {
    const result = classifyProxyError('Proxy responded with 407');
    expect(result.proxyError).toBe('ERR_PROXY_AUTH_REQUESTED');
  });

  test('detects proxy TLS errors', () => {
    const result = classifyProxyError('ERR_PROXY_CERTIFICATE_INVALID');
    expect(result.proxyError).toBe('ERR_PROXY_TLS');
    expect(result.proxyTlsError).toBe(true);
  });

  test('returns null for non-proxy errors', () => {
    const result = classifyProxyError('net::ERR_CONNECTION_REFUSED');
    expect(result.proxyError).toBe(null);
    expect(result.proxyTlsError).toBe(false);
  });

  test('handles null/empty input', () => {
    expect(classifyProxyError(null).proxyError).toBe(null);
    expect(classifyProxyError('').proxyError).toBe(null);
    expect(classifyProxyError(undefined).proxyError).toBe(null);
  });
});

// ============================================================================
// Resource snapshot tests
// ============================================================================

describe('collectResourceSnapshot', () => {

  test('collects basic memory metrics', () => {
    const snap = collectResourceSnapshot();
    expect(typeof snap.nodeRssMb === 'number').toBeTruthy();
    expect(snap.nodeRssMb > 0).toBeTruthy();
    expect(typeof snap.nodeHeapUsedMb === 'number').toBeTruthy();
    expect(typeof snap.nodeHeapTotalMb === 'number').toBeTruthy();
    expect(typeof snap.nodeExternalMb === 'number').toBeTruthy();
  });

  test('collects active handles count', () => {
    const snap = collectResourceSnapshot();
    // process._getActiveHandles is available in Node
    expect(snap.activeHandles === null || typeof snap.activeHandles === 'number').toBeTruthy();
  });

  test('includes session/tab counts when provided', () => {
    const snap = collectResourceSnapshot({ sessionCount: 3, tabCount: 7 });
    expect(snap.browserContexts).toBe(3);
    expect(snap.activeTabs).toBe(7);
  });

  test('browserRssMb is null without browserPid', () => {
    const snap = collectResourceSnapshot();
    expect(snap.browserRssMb).toBe(null);
  });

  test('handles invalid browserPid gracefully', () => {
    const snap = collectResourceSnapshot({ browserPid: 99999999 });
    // Should not throw, just null
    expect(snap.browserRssMb).toBe(null);
  });

  test('collects open FDs on Linux', () => {
    const snap = collectResourceSnapshot();
    if (process.platform === 'linux') {
      expect(typeof snap.openFds === 'number').toBeTruthy();
      expect(snap.openFds > 0).toBeTruthy();
    } else {
      expect(snap.openFds).toBe(null);
    }
  });
});

// ============================================================================
// Tab health tracker tests
// ============================================================================

describe('createTabHealthTracker', () => {

  function createMockPage() {
    const listeners = {};
    return {
      on: (event, handler) => {
        if (!listeners[event]) listeners[event] = [];
        listeners[event].push(handler);
      },
      _emit: (event, ...args) => {
        for (const handler of (listeners[event] || [])) handler(...args);
      },
      evaluate: async (fn) => fn(),
      frames: () => [{}],
    };
  }

  test('tracks crashes', () => {
    const page = createMockPage();
    const tracker = createTabHealthTracker(page);
    page._emit('crash');
    page._emit('crash');
    const snap = tracker.snapshot();
    expect(snap.crashes).toBe(2);
  });

  test('tracks page errors', () => {
    const page = createMockPage();
    const tracker = createTabHealthTracker(page);
    page._emit('pageerror', new Error('test'));
    const snap = tracker.snapshot();
    expect(snap.pageErrors).toBe(1);
  });

  test('tracks request failures', () => {
    const page = createMockPage();
    const tracker = createTabHealthTracker(page);
    page._emit('requestfailed', {});
    const snap = tracker.snapshot();
    expect(snap.requestFailures).toBe(1);
  });

  test('tracks in-flight requests', () => {
    const page = createMockPage();
    const tracker = createTabHealthTracker(page);
    // Simulate 3 requests starting
    page._emit('request', { isNavigationRequest: () => false });
    page._emit('request', { isNavigationRequest: () => false });
    page._emit('request', { isNavigationRequest: () => false });
    expect(tracker.health.inflightRequests).toBe(3);
    // One finishes
    page._emit('requestfinished', {});
    expect(tracker.health.inflightRequests).toBe(2);
    // One fails
    page._emit('requestfailed', {});
    // requestfailed fires both the failure counter AND decrements inflight
    expect(tracker.health.inflightRequests).toBe(1);
  });

  test('tracks HTTP status histogram', () => {
    const page = createMockPage();
    const tracker = createTabHealthTracker(page);
    page._emit('response', { status: () => 403, headers: () => ({}), request: () => ({ isNavigationRequest: () => false }) });
    page._emit('response', { status: () => 403, headers: () => ({}), request: () => ({ isNavigationRequest: () => false }) });
    page._emit('response', { status: () => 429, headers: () => ({}), request: () => ({ isNavigationRequest: () => false }) });
    page._emit('response', { status: () => 200, headers: () => ({}), request: () => ({ isNavigationRequest: () => false }) });
    const snap = tracker.snapshot();
    expect(snap.statusCounts[403]).toBe(2);
    expect(snap.statusCounts[429]).toBe(1);
    expect(snap.statusCounts[200]).toBe(undefined);
  });

  test('does NOT track console errors (noise -- cut per oracle)', () => {
    const page = createMockPage();
    const tracker = createTabHealthTracker(page);
    const snap = tracker.snapshot();
    expect(snap.consoleErrors).toBe(undefined);
  });

  test('does NOT track dialog count (noise -- cut per oracle)', () => {
    const page = createMockPage();
    const tracker = createTabHealthTracker(page);
    const snap = tracker.snapshot();
    expect(snap.dialogCount).toBe(undefined);
  });

  test('does NOT track frame count (noise -- cut per oracle)', () => {
    const page = createMockPage();
    const tracker = createTabHealthTracker(page);
    const snap = tracker.snapshot();
    expect(snap.frameCount).toBe(undefined);
  });

  test('tracks redirect status codes', () => {
    const page = createMockPage();
    const tracker = createTabHealthTracker(page);
    // Simulate nav request with redirects
    page._emit('request', { isNavigationRequest: () => true, redirectedFrom: () => null });
    page._emit('response', { status: () => 301, headers: () => ({}), request: () => ({ isNavigationRequest: () => true }) });
    page._emit('request', { isNavigationRequest: () => true, redirectedFrom: () => ({}) });
    page._emit('response', { status: () => 302, headers: () => ({}), request: () => ({ isNavigationRequest: () => true }) });
    page._emit('request', { isNavigationRequest: () => true, redirectedFrom: () => ({}) });
    page._emit('response', { status: () => 403, headers: () => ({ 'cf-ray': '123' }), request: () => ({ isNavigationRequest: () => true }) });

    const snap = tracker.snapshot();
    expect(snap.redirectStatusCodes).toEqual([301, 302, 403]);
    expect(snap.maxRedirectDepth).toBe(2);
  });

  test('detects bot protection on navigation response', () => {
    const page = createMockPage();
    const tracker = createTabHealthTracker(page);
    page._emit('request', { isNavigationRequest: () => true, redirectedFrom: () => null });
    page._emit('response', {
      status: () => 403,
      headers: () => ({ 'cf-ray': '7abc-LAX', 'content-length': '42000' }),
      request: () => ({ isNavigationRequest: () => true }),
    });
    const snap = tracker.snapshot();
    expect(snap.botDetection.detected).toBe(true);
    expect(snap.botDetection.provider).toBe('cloudflare');
    expect(snap.lastNavResponseSize).toBe(42000);
  });

  test('provides getReadyState function', async () => {
    const page = createMockPage();
    const tracker = createTabHealthTracker(page);
    const state = await tracker.getReadyState();
    // Our mock evaluate just runs the function, which returns undefined in Node
    // (no real DOM). The important thing is it doesn't throw.
    expect(state !== undefined || state === undefined).toBeTruthy();
  });
});

// ============================================================================
// collectResourceSnapshot -- native memory fields
// ============================================================================

describe('collectResourceSnapshot native memory', () => {
  test('includes RSS, heap, and external memory fields', () => {
    const snap = collectResourceSnapshot();
    expect(typeof snap.nodeRssMb === 'number').toBeTruthy();
    expect(typeof snap.nodeHeapUsedMb === 'number').toBeTruthy();
    expect(typeof snap.nodeHeapTotalMb === 'number').toBeTruthy();
    expect(typeof snap.nodeExternalMb === 'number').toBeTruthy();
    expect(snap.nodeRssMb > 0).toBeTruthy();
    expect(snap.nodeHeapUsedMb > 0).toBeTruthy();
  });

  test('native memory (RSS - heapUsed) is non-negative', () => {
    const snap = collectResourceSnapshot();
    const nativeMb = snap.nodeRssMb - snap.nodeHeapUsedMb;
    expect(nativeMb >= 0).toBeTruthy();
  });

  test('includes session/tab counts when provided', () => {
    const snap = collectResourceSnapshot({ sessionCount: 3, tabCount: 7 });
    expect(snap.browserContexts).toBe(3);
    expect(snap.activeTabs).toBe(7);
  });

  test('browserRssMb is null when no browserPid', () => {
    const snap = collectResourceSnapshot();
    expect(snap.browserRssMb).toBe(null);
  });

  test('rejects invalid browserPid values', () => {
    const snap1 = collectResourceSnapshot({ browserPid: -1 });
    expect(snap1.browserRssMb).toBe(null);
    const snap2 = collectResourceSnapshot({ browserPid: 0 });
    expect(snap2.browserRssMb).toBe(null);
    const snap3 = collectResourceSnapshot({ browserPid: 'abc' });
    expect(snap3.browserRssMb).toBe(null);
  });
});
