// Minimal Camofox client. One instance per end user.
//
//   import { forUser } from './camofox-client.mjs';
//   const browser = forUser(userIdFromYourSession);   // NEVER from user-typed text
//   const { tabId } = await browser.openTab({ url, sessionKey: taskId });
//
// Errors carry .status and .code (for example 'human_in_control').
import { loadDotEnv } from './lib-env.mjs';

const ENV = { ...loadDotEnv(), ...process.env };

export class CamofoxError extends Error {
  constructor(message, status, body) {
    super(message);
    this.name = 'CamofoxError';
    this.status = status;
    this.code = body?.code || body?.error || null;
    this.body = body;
  }
}

export class CamofoxClient {
  constructor({ baseUrl = ENV.CAMOFOX_BASE_URL, accessKey = ENV.CAMOFOX_ACCESS_KEY, userId } = {}) {
    if (!baseUrl) throw new Error('CAMOFOX_BASE_URL is not set.');
    if (!accessKey) throw new Error('CAMOFOX_ACCESS_KEY is not set.');
    if (typeof userId !== 'string' || !userId.trim()) {
      throw new Error('userId is required. Pass the end user\'s ID from your authenticated session.');
    }
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    this.#key = accessKey;
    this.userId = userId.trim();
  }

  #key;

  async #call(method, path, { query, body, timeoutMs = 60000 } = {}) {
    const url = new URL(this.baseUrl + path);
    if (query) for (const [k, v] of Object.entries(query)) if (v !== undefined) url.searchParams.set(k, String(v));
    const headers = { Authorization: `Bearer ${this.#key}` };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const res = await fetch(url, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await res.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch { data = { raw: text.slice(0, 200) }; }
    if (!res.ok) {
      throw new CamofoxError(`Camofox ${method} ${path} failed (HTTP ${res.status}): ${data?.error || data?.code || 'no detail'}`, res.status, data);
    }
    return data;
  }

  health() { return this.#call('GET', '/health'); }

  openTab({ url, sessionKey, trace } = {}) {
    if (!sessionKey) throw new Error('sessionKey is required (groups the tabs of one task).');
    return this.#call('POST', '/tabs', { body: { userId: this.userId, sessionKey, url, trace } });
  }

  navigate(tabId, { url, macro, query, sessionKey } = {}) {
    return this.#call('POST', `/tabs/${enc(tabId)}/navigate`, { body: { userId: this.userId, url, macro, query, sessionKey } });
  }

  state(tabId) {
    return this.#call('GET', `/tabs/${enc(tabId)}/state`, { query: { userId: this.userId } });
  }

  snapshot(tabId) {
    return this.#call('GET', `/tabs/${enc(tabId)}/snapshot`, { query: { userId: this.userId } });
  }

  click(tabId, { ref, selector }) {
    return this.#call('POST', `/tabs/${enc(tabId)}/click`, { body: { userId: this.userId, ref, selector } });
  }

  type(tabId, { ref, selector, text, pressEnter = false }) {
    return this.#call('POST', `/tabs/${enc(tabId)}/type`, { body: { userId: this.userId, ref, selector, text, pressEnter } });
  }

  // kinds: ['tables','prices','json_ld','listings'] (default: all). Or pass schema (needs a snapshot first).
  extract(tabId, { kinds, schema } = {}) {
    if (kinds && schema) throw new Error('Pass kinds or schema, not both.');
    return this.#call('POST', `/tabs/${enc(tabId)}/extract`, { body: { userId: this.userId, kinds, schema } });
  }

  checkpoint(tabId) {
    return this.#call('POST', `/tabs/${enc(tabId)}/checkpoint`, { body: { userId: this.userId } });
  }

  startHandoff(tabId, { reason, idleMs } = {}) {
    if (!reason) throw new Error('reason is required so the user knows what to do.');
    return this.#call('POST', `/tabs/${enc(tabId)}/handoff`, { body: { userId: this.userId, reason, idleMs } });
  }

  // Link for this user only. Send it to them in chat. Requires an active handoff.
  async controlLink(tabId, { ttlSeconds = 3600 } = {}) {
    const out = await this.#call('POST', '/live-viewer/links', { body: { userId: this.userId, tabId, control: true, ttlSeconds } });
    return out.url;
  }

  release(tabId) {
    return this.#call('POST', `/tabs/${enc(tabId)}/handoff/release`, { body: { userId: this.userId } });
  }

  closeTab(tabId) {
    return this.#call('DELETE', `/tabs/${enc(tabId)}`, { query: { userId: this.userId } });
  }

  endSession() {
    return this.#call('DELETE', `/sessions/${enc(this.userId)}`);
  }
}

export function forUser(userId, options = {}) {
  return new CamofoxClient({ ...options, userId });
}

function enc(v) { return encodeURIComponent(String(v)); }
