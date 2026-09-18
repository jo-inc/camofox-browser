import { describe, expect, test } from '@jest/globals';
import { attachNavigationResponseTracker, readInlinePdfResponse } from '../../lib/downloads.js';

function fakeResponse({ url, contentType, contentLength, body, navigation = true, frame = 'main', status = 200 }) {
  const headers = {};
  if (contentType) headers['content-type'] = contentType;
  if (contentLength !== undefined) headers['content-length'] = String(contentLength);
  return {
    url: () => url,
    status: () => status,
    headers: () => headers,
    body: async () => body,
    request: () => ({
      isNavigationRequest: () => navigation,
      frame: () => frame,
    }),
  };
}

function fakeTabState() {
  const listeners = {};
  const page = {
    on: (event, cb) => { listeners[event] = cb; },
    mainFrame: () => 'main',
  };
  return { tabState: { page }, emit: (event, arg) => listeners[event]?.(arg) };
}

describe('attachNavigationResponseTracker', () => {
  test('stores only main-frame navigation responses, latest wins', () => {
    const { tabState, emit } = fakeTabState();
    attachNavigationResponseTracker(tabState);
    const html = fakeResponse({ url: 'https://x/a', contentType: 'text/html', body: Buffer.from('<p>') });
    const sub = fakeResponse({ url: 'https://x/img.png', contentType: 'image/png', body: Buffer.alloc(1), navigation: false });
    const iframe = fakeResponse({ url: 'https://x/frame', contentType: 'text/html', body: Buffer.alloc(1), frame: 'child' });
    const pdf = fakeResponse({ url: 'https://x/a.pdf', contentType: 'application/pdf', body: Buffer.from('%PDF-1.4') });
    emit('response', html);
    expect(tabState.lastMainFrameResponse).toBe(html);
    emit('response', sub);
    emit('response', iframe);
    expect(tabState.lastMainFrameResponse).toBe(html);
    emit('response', pdf);
    expect(tabState.lastMainFrameResponse).toBe(pdf);
  });

  test('is idempotent and tolerates pages without on()', () => {
    const { tabState } = fakeTabState();
    attachNavigationResponseTracker(tabState);
    attachNavigationResponseTracker(tabState);
    expect(tabState.navigationResponseTrackerAttached).toBe(true);
    expect(() => attachNavigationResponseTracker({ page: null })).not.toThrow();
  });
});

describe('readInlinePdfResponse', () => {
  test('returns the PDF body when url matches and type is application/pdf', async () => {
    const { tabState, emit } = fakeTabState();
    attachNavigationResponseTracker(tabState);
    const pdf = fakeResponse({ url: 'https://x/a.pdf', contentType: 'application/pdf; qs=0.001', body: Buffer.from('%PDF-1.4 body') });
    emit('response', pdf);
    const out = await readInlinePdfResponse(tabState, 'https://x/a.pdf');
    expect(out).not.toBeNull();
    expect(out.mimeType).toBe('application/pdf');
    expect(out.body.toString()).toBe('%PDF-1.4 body');
    expect(out.status).toBe(200);
  });

  test('returns the declared size limit before reading an oversized PDF body', async () => {
    const { tabState, emit } = fakeTabState();
    attachNavigationResponseTracker(tabState);
    const pdf = fakeResponse({
      url: 'https://x/a.pdf',
      contentType: 'application/pdf',
      contentLength: 50 * 1024 * 1024 + 1,
      body: Buffer.alloc(1),
    });
    pdf.body = async () => { throw new Error('body should not be read'); };
    emit('response', pdf);
    await expect(readInlinePdfResponse(tabState, 'https://x/a.pdf')).resolves.toEqual({ exceedsLimit: true });
  });

  test('returns null for html, url mismatch, empty body, body() failure, or no response', async () => {
    const { tabState, emit } = fakeTabState();
    attachNavigationResponseTracker(tabState);
    expect(await readInlinePdfResponse(tabState, 'https://x/a.pdf')).toBeNull();
    emit('response', fakeResponse({ url: 'https://x/a.pdf', contentType: 'text/html', body: Buffer.from('<p>') }));
    expect(await readInlinePdfResponse(tabState, 'https://x/a.pdf')).toBeNull();
    emit('response', fakeResponse({ url: 'https://x/b.pdf', contentType: 'application/pdf', body: Buffer.from('%PDF') }));
    expect(await readInlinePdfResponse(tabState, 'https://x/a.pdf')).toBeNull();
    emit('response', fakeResponse({ url: 'https://x/a.pdf', contentType: 'application/pdf', body: Buffer.alloc(0) }));
    expect(await readInlinePdfResponse(tabState, 'https://x/a.pdf')).toBeNull();
    const broken = fakeResponse({ url: 'https://x/a.pdf', contentType: 'application/pdf', body: null });
    broken.body = async () => { throw new Error('body evicted'); };
    emit('response', broken);
    expect(await readInlinePdfResponse(tabState, 'https://x/a.pdf')).toBeNull();
    expect(await readInlinePdfResponse({}, 'https://x/a.pdf')).toBeNull();
  });
});
