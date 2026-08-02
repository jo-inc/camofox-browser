import { describe, test, expect } from '@jest/globals';
import {
  captureResponses,
  captureRequests,
  PENDING_BODY_MARKER,
  BODY_ERROR_PREFIX,
  TRUNCATED_MARKER,
} from '../../lib/network-capture.js';

// Minimal stand-in for a Playwright page: only on/off are used by the capture
// helpers, plus emit/listenerCount so the tests can drive and inspect them.
function fakePage() {
  const listeners = new Map();
  return {
    on(event, fn) {
      if (!listeners.has(event)) listeners.set(event, new Set());
      listeners.get(event).add(fn);
    },
    off(event, fn) {
      listeners.get(event)?.delete(fn);
    },
    emit(event, arg) {
      for (const fn of [...(listeners.get(event) ?? [])]) fn(arg);
    },
    listenerCount(event) {
      return listeners.get(event)?.size ?? 0;
    },
  };
}

function fakeResponse(url, { status = 200, text } = {}) {
  return { url: () => url, status: () => status, text };
}

function fakeRequest(url, { method = 'POST', postData = '', headers = {} } = {}) {
  return { url: () => url, method: () => method, postData: () => postData, headers: () => headers };
}

const flush = () => new Promise((resolve) => setImmediate(resolve));

const baseOpts = {
  regex: /graphql/i,
  durationMs: 0,
  maxBodyBytes: 1000,
  maxCaptures: 10,
  drainTimeoutMs: 1000,
};

describe('captureResponses', () => {
  test('awaits a body still in flight when the capture window closes', async () => {
    const page = fakePage();
    let releaseBody;
    const body = new Promise((resolve) => { releaseBody = resolve; });

    // The response lands at the very end of the window: the listener is detached
    // immediately after, while response.text() is still pending.
    const pending = captureResponses(page, {
      ...baseOpts,
      sleep: async () => { page.emit('response', fakeResponse('https://x.test/graphql', { text: () => body })); },
    });

    await flush();
    releaseBody('{"data":{"ok":true}}');
    const result = await pending;

    expect(result.captureCount).toBe(1);
    expect(result.pendingBodies).toBe(0);
    expect(result.captures[0]).toMatchObject({
      url: 'https://x.test/graphql',
      status: 200,
      body: '{"data":{"ok":true}}',
      len: 20,
    });
  });

  test('detaches the listener even though it waits for in-flight bodies', async () => {
    const page = fakePage();
    let releaseBody;
    const body = new Promise((resolve) => { releaseBody = resolve; });

    const pending = captureResponses(page, {
      ...baseOpts,
      sleep: async () => { page.emit('response', fakeResponse('https://x.test/graphql', { text: () => body })); },
    });

    await flush();
    expect(page.listenerCount('response')).toBe(0);

    // A response arriving after the window is ignored, not captured.
    page.emit('response', fakeResponse('https://x.test/graphql?late=1', { text: async () => 'late' }));
    releaseBody('ok');
    const result = await pending;
    expect(result.captureCount).toBe(1);
  });

  test('bounds the drain and marks bodies that never arrive', async () => {
    const page = fakePage();
    const started = Date.now();

    const result = await captureResponses(page, {
      ...baseOpts,
      drainTimeoutMs: 50,
      sleep: async () => {
        page.emit('response', fakeResponse('https://x.test/graphql', { text: () => new Promise(() => {}) }));
      },
    });

    expect(Date.now() - started).toBeLessThan(2000);
    expect(result.pendingBodies).toBe(1);
    expect(result.captures[0].body).toBe(PENDING_BODY_MARKER);
  });

  test('only captures URLs matching the pattern', async () => {
    const page = fakePage();
    const result = await captureResponses(page, {
      ...baseOpts,
      sleep: async () => {
        page.emit('response', fakeResponse('https://x.test/static/app.js', { text: async () => 'js' }));
        page.emit('response', fakeResponse('https://x.test/GraphQL', { text: async () => 'hit' }));
      },
    });

    expect(result.captures.map((c) => c.url)).toEqual(['https://x.test/GraphQL']);
  });

  test('enforces maxCaptures at arrival time and reports the drops', async () => {
    const page = fakePage();
    const result = await captureResponses(page, {
      ...baseOpts,
      maxCaptures: 2,
      sleep: async () => {
        for (let i = 0; i < 5; i++) {
          page.emit('response', fakeResponse(`https://x.test/graphql?i=${i}`, { text: async () => `b${i}` }));
        }
      },
    });

    expect(result.captureCount).toBe(2);
    expect(result.droppedByLimit).toBe(3);
    expect(result.captures.map((c) => c.body)).toEqual(['b0', 'b1']);
  });

  test('preserves arrival order when bodies resolve out of order', async () => {
    const page = fakePage();
    let releaseFirst;
    const first = new Promise((resolve) => { releaseFirst = resolve; });

    const pending = captureResponses(page, {
      ...baseOpts,
      sleep: async () => {
        page.emit('response', fakeResponse('https://x.test/graphql/1', { text: () => first }));
        page.emit('response', fakeResponse('https://x.test/graphql/2', { text: async () => 'second' }));
      },
    });

    await flush();
    releaseFirst('first');
    const result = await pending;
    expect(result.captures.map((c) => c.url)).toEqual(['https://x.test/graphql/1', 'https://x.test/graphql/2']);
    expect(result.captures.map((c) => c.body)).toEqual(['first', 'second']);
  });

  test('truncates oversized bodies and records a failed read', async () => {
    const page = fakePage();
    const result = await captureResponses(page, {
      ...baseOpts,
      maxBodyBytes: 8,
      sleep: async () => {
        page.emit('response', fakeResponse('https://x.test/graphql/big', { text: async () => 'x'.repeat(50) }));
        page.emit('response', fakeResponse('https://x.test/graphql/err', {
          text: async () => { throw new Error('body unavailable'); },
        }));
      },
    });

    expect(result.captures[0].body).toBe('x'.repeat(8) + TRUNCATED_MARKER);
    expect(result.captures[1].body).toBe(`${BODY_ERROR_PREFIX}body unavailable`);
    expect(result.pendingBodies).toBe(0);
  });
});

describe('captureRequests', () => {
  test('captures matching requests with body and headers', async () => {
    const page = fakePage();
    const result = await captureRequests(page, {
      ...baseOpts,
      sleep: async () => {
        page.emit('request', fakeRequest('https://x.test/graphql', {
          postData: '{"query":"{me}"}',
          headers: { authorization: 'Bearer x' },
        }));
        page.emit('request', fakeRequest('https://x.test/ping'));
      },
    });

    expect(result.captureCount).toBe(1);
    expect(result.captures[0]).toMatchObject({
      url: 'https://x.test/graphql',
      method: 'POST',
      body: '{"query":"{me}"}',
      headers: { authorization: 'Bearer x' },
    });
    expect(page.listenerCount('request')).toBe(0);
  });

  test('omits headers when includeHeaders is false', async () => {
    const page = fakePage();
    const result = await captureRequests(page, {
      ...baseOpts,
      includeHeaders: false,
      sleep: async () => {
        page.emit('request', fakeRequest('https://x.test/graphql', { headers: { cookie: 'secret' } }));
      },
    });

    expect(result.captures[0].headers).toEqual({});
  });

  test('enforces maxCaptures and reports the drops', async () => {
    const page = fakePage();
    const result = await captureRequests(page, {
      ...baseOpts,
      maxCaptures: 1,
      sleep: async () => {
        page.emit('request', fakeRequest('https://x.test/graphql?a'));
        page.emit('request', fakeRequest('https://x.test/graphql?b'));
      },
    });

    expect(result.captureCount).toBe(1);
    expect(result.droppedByLimit).toBe(1);
  });
});
