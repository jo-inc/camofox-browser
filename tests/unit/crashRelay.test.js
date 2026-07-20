/**
 * Tests for the crash relay client (sendToRelay) and reporter<->relay integration.
 *
 * Uses Jest with mock fetch to verify:
 * - sendToRelay payload format and error handling
 * - createReporter sends correct payloads to the relay
 * - Relay URL override via config
 * - No secrets in outbound requests
 */
import { describe, test, expect, beforeEach, afterEach } from '@jest/globals';
import { jest } from '@jest/globals';
import {
  anonymize, stackSignature, createReporter, sendToRelay,
} from '../../lib/reporter.js';

// ============================================================================
// Mock fetch for relay tests
// ============================================================================

let fetchCalls = [];
let fetchResponse = { ok: true, status: 200, json: async () => ({ status: 'created' }) };

const originalFetch = globalThis.fetch;

beforeEach(() => {
  fetchCalls = [];
  fetchResponse = { ok: true, status: 200, json: async () => ({ status: 'created' }) };
  globalThis.fetch = async (url, opts) => {
    fetchCalls.push({ url, opts });
    return fetchResponse;
  };
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

// ============================================================================
// sendToRelay tests
// ============================================================================

describe('sendToRelay', () => {

  test('sends POST with JSON Content-Type', async () => {
    await sendToRelay({ type: 'crash', signature: 'aabb1122', title: 'test', body: 'body', labels: ['crash'] });
    expect(fetchCalls).toHaveLength(1);
    const { url, opts } = fetchCalls[0];
    expect(url).toContain('camofox-telemetry.askjo.workers.dev/report');
    expect(opts.method).toBe('POST');
    expect(opts.headers['Content-Type']).toBe('application/json');
  });

  test('sends correct payload shape', async () => {
    const payload = {
      type: 'hang:navigate',
      signature: 'deadbeef',
      title: '[deadbeef] hang: test',
      body: '## Error\ntest',
      labels: ['hang', 'auto-report'],
      version: '1.8.2',
    };
    await sendToRelay(payload);
    expect(fetchCalls).toHaveLength(1);
    const sent = JSON.parse(fetchCalls[0].opts.body);
    expect(sent.type).toBe('hang:navigate');
    expect(sent.signature).toBe('deadbeef');
    expect(sent.title).toBe('[deadbeef] hang: test');
    expect(sent.labels).toEqual(['hang', 'auto-report']);
    expect(sent.version).toBe('1.8.2');
  });

  test('returns true on 200', async () => {
    fetchResponse = { ok: true, status: 200 };
    const result = await sendToRelay({ type: 'crash', signature: '11223344', title: 't', body: 'b', labels: [] });
    expect(result).toBe(true);
  });

  test('returns true on 429 (rate limited is not an error)', async () => {
    fetchResponse = { ok: false, status: 429 };
    const result = await sendToRelay({ type: 'crash', signature: '11223344', title: 't', body: 'b', labels: [] });
    expect(result).toBe(true);
  });

  test('returns false on 500', async () => {
    fetchResponse = { ok: false, status: 500 };
    const result = await sendToRelay({ type: 'crash', signature: '11223344', title: 't', body: 'b', labels: [] });
    expect(result).toBe(false);
  });

  test('returns false on fetch error (never throws)', async () => {
    globalThis.fetch = async () => { throw new Error('network error'); };
    const result = await sendToRelay({ type: 'crash', signature: '11223344', title: 't', body: 'b', labels: [] });
    expect(result).toBe(false);
  });

  test('includes abort signal for timeout', async () => {
    await sendToRelay({ type: 'crash', signature: '11223344', title: 't', body: 'b', labels: [] });
    expect(fetchCalls[0].opts.signal).toBeDefined();
    expect(fetchCalls[0].opts.signal).toBeInstanceOf(AbortSignal);
  });
});

// ============================================================================
// sendToRelay payload contains NO secrets
// ============================================================================

describe('sendToRelay security', () => {

  test('payload never contains GitHub App credentials', async () => {
    const payload = {
      type: 'crash',
      signature: 'aabbccdd',
      title: 'test crash',
      body: 'stack trace here',
      labels: ['crash', 'auto-report'],
      version: '1.8.2',
    };
    await sendToRelay(payload);
    const raw = fetchCalls[0].opts.body;
    // Must not contain any of the old embedded key patterns
    expect(raw).not.toContain('keyA');
    expect(raw).not.toContain('keyB');
    expect(raw).not.toContain('appId');
    expect(raw).not.toContain('installationId');
    expect(raw).not.toContain('PRIVATE KEY');
    expect(raw).not.toContain('LS0tLS1CRUdJTi'); // base64 "-----BEGIN"
  });
});

// ============================================================================
// createReporter -> relay integration
// ============================================================================

describe('createReporter relay integration', () => {

  test('reportCrash sends to relay with correct type and labels', async () => {
    const reporter = createReporter({ crashReportEnabled: true, version: '1.8.2' });
    await reporter.reportCrash(new Error('test error'));
    // Wait for the async in-flight promise
    await reporter.stop();
    expect(fetchCalls.length).toBeGreaterThanOrEqual(1);
    const sent = JSON.parse(fetchCalls[0].opts.body);
    expect(sent.type).toMatch(/^(Error|crash)/);
    expect(sent.labels).toContain('crash');
    expect(sent.labels).toContain('auto-report');
    expect(sent.signature).toMatch(/^[0-9a-f]{8}$/);
    expect(sent.title).toContain(`[${sent.signature}]`);
    expect(sent.version).toBe('1.8.2');
  });

  test('reportCrash with signal sends signal:TYPE', async () => {
    const reporter = createReporter({ crashReportEnabled: true, version: '1.8.2' });
    await reporter.reportCrash(new Error('killed'), { signal: 'SIGTERM' });
    await reporter.stop();
    expect(fetchCalls.length).toBeGreaterThanOrEqual(1);
    const sent = JSON.parse(fetchCalls[0].opts.body);
    expect(sent.type).toBe('signal:SIGTERM');
  });

  test('reportHang sends hang:operation type', async () => {
    const reporter = createReporter({ crashReportEnabled: true, version: '1.8.2' });
    await reporter.reportHang('navigate', 30000);
    await reporter.stop();
    expect(fetchCalls.length).toBeGreaterThanOrEqual(1);
    const sent = JSON.parse(fetchCalls[0].opts.body);
    expect(sent.type).toBe('hang:navigate');
    expect(sent.labels).toContain('hang');
  });

  test('reportStuckLoop sends stuck:tab-lock type', async () => {
    const reporter = createReporter({ crashReportEnabled: true, version: '1.8.2' });
    await reporter.reportStuckLoop(60000);
    await reporter.stop();
    expect(fetchCalls.length).toBeGreaterThanOrEqual(1);
    const sent = JSON.parse(fetchCalls[0].opts.body);
    expect(sent.type).toBe('stuck:tab-lock');
    expect(sent.labels).toContain('stuck');
  });

  test('body contains anonymized content', async () => {
    const reporter = createReporter({ crashReportEnabled: true });
    const err = new Error('Failed connecting to https://secret.internal.corp/api');
    await reporter.reportCrash(err);
    await reporter.stop();
    const sent = JSON.parse(fetchCalls[0].opts.body);
    expect(sent.body).not.toContain('secret.internal.corp');
    expect(sent.body).toContain('<https-url>');
  });

  test('disabled reporter does not send to relay', async () => {
    const reporter = createReporter({ crashReportEnabled: false });
    await reporter.reportCrash(new Error('test'));
    await reporter.stop();
    expect(fetchCalls).toHaveLength(0);
  });

  test('rate limiter prevents excess reports', async () => {
    const reporter = createReporter({ crashReportEnabled: true, crashReportRateLimit: 2 });
    // Exhaust the crash-specific rate limiter (5/hr default)
    const rl = reporter._rateLimiter.crash;
    for (let i = 0; i < 5; i++) rl.tryAcquire();
    // This should be rate-limited
    await reporter.reportCrash(new Error('over limit'));
    await reporter.stop();
    expect(fetchCalls).toHaveLength(0);
  });
});

// ============================================================================
// Relay URL override
// ============================================================================

describe('relay URL override', () => {

  test('default URL is camofox-telemetry.askjo.workers.dev', async () => {
    createReporter({ crashReportEnabled: true });
    // sendToRelay uses the module-level _relayUrl set by createReporter
    await sendToRelay({ type: 'crash', signature: '11223344', title: 't', body: 'b', labels: [] });
    expect(fetchCalls[0].url).toBe('https://camofox-telemetry.askjo.workers.dev/report');
  });

  test('custom URL via config.crashReportUrl', async () => {
    createReporter({ crashReportEnabled: true, crashReportUrl: 'https://my-relay.example.com/report' });
    await sendToRelay({ type: 'crash', signature: '11223344', title: 't', body: 'b', labels: [] });
    expect(fetchCalls[0].url).toBe('https://my-relay.example.com/report');
  });

  test('empty crashReportUrl falls back to default', async () => {
    createReporter({ crashReportEnabled: true, crashReportUrl: '' });
    await sendToRelay({ type: 'crash', signature: '11223344', title: 't', body: 'b', labels: [] });
    expect(fetchCalls[0].url).toBe('https://camofox-telemetry.askjo.workers.dev/report');
  });
});

