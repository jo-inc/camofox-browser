/**
 * AgentCard REST client (https://api.agentcard.sh/api/v2).
 *
 * Endpoints follow the AgentCard API reference:
 *   POST /oauth/token                          client credentials
 *   POST /vault_sessions                       enrol or unlock a card vault
 *   GET  /vault_sessions/{id}                  poll: pending | linked | expired
 *   GET  /vault_cards?user_id=                 display fields only
 *   POST /checkout/preparations                approve merchant and amount first
 *   POST /checkout/authorizations              approval link for one purchase
 *   GET  /checkout/authorizations/{id}         status and settlement
 *   POST /checkout/authorizations/{id}/cancel  stop while awaiting approval
 *   POST /webhook_endpoints                    register our receiver
 *   GET  /webhook_endpoints/{id}/secret        read the signing secret
 *
 * Behaviour:
 * - One client-credentials token, cached until shortly before it expires. The
 *   API allows 30 token requests per 5 minutes per IP, so concurrent callers
 *   share one exchange.
 * - 429 and 5xx responses retry with backoff (Retry-After respected).
 * - 400 `slow_down` on a status read waits the server's interval and retries once.
 * - Errors carry the HTTP status and the API error code. They never include
 *   the token, the client secret, or request bodies.
 */

export const DEFAULT_BASE_URL = 'https://api.agentcard.sh';
const TOKEN_REFRESH_MARGIN_MS = 60_000;

export class AgentCardError extends Error {
  /**
   * @param {string} message
   * @param {{ status?: number, code?: string | null, retryable?: boolean }} [details]
   */
  constructor(message, { status = 0, code = null, retryable = false } = {}) {
    super(message);
    this.name = 'AgentCardError';
    this.status = status;
    this.code = code;
    this.retryable = retryable;
  }
}

/**
 * @param {{
 *   clientId: string,
 *   clientSecret: string,
 *   baseUrl?: string,
 *   fetchImpl?: typeof fetch,
 *   now?: () => number,
 *   sleep?: (ms: number) => Promise<void>,
 *   maxRetries?: number,
 * }} options
 */
export function createAgentCardApi({
  clientId,
  clientSecret,
  baseUrl = DEFAULT_BASE_URL,
  fetchImpl = fetch,
  now = () => Date.now(),
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  maxRetries = 3,
}) {
  if (!clientId || !clientSecret) throw new AgentCardError('clientId and clientSecret are required');

  let token = null; // { value, expiresAt }
  let tokenInFlight = null;

  async function fetchToken() {
    const form = new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: clientId,
      client_secret: clientSecret,
    });
    const res = await fetchImpl(`${baseUrl}/api/v2/oauth/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: form,
    });
    const body = await readBody(res);
    if (!res.ok || !body?.access_token) {
      throw toError(res.status, body, 'Could not get an AgentCard access token');
    }
    const lifetimeMs = (Number(body.expires_in) || 3600) * 1000;
    token = { value: body.access_token, expiresAt: now() + lifetimeMs };
    return token.value;
  }

  async function getToken() {
    if (token && now() < token.expiresAt - TOKEN_REFRESH_MARGIN_MS) return token.value;
    if (!tokenInFlight) {
      tokenInFlight = fetchToken().finally(() => { tokenInFlight = null; });
    }
    return tokenInFlight;
  }

  /**
   * @param {string} method
   * @param {string} path starts with /
   * @param {{ body?: object, query?: Record<string, string>, _slowDownRetried?: boolean }} [opts]
   */
  async function request(method, path, { body, query, _slowDownRetried = false } = {}) {
    const qs = query ? `?${new URLSearchParams(query).toString()}` : '';
    let attempt = 0;
    for (;;) {
      const accessToken = await getToken();
      const res = await fetchImpl(`${baseUrl}/api/v2${path}${qs}`, {
        method,
        headers: {
          authorization: `Bearer ${accessToken}`,
          ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
      const data = await readBody(res);

      if (res.ok) return data;

      const code = data?.error?.code ?? data?.code ?? null;

      if (code === 'slow_down' && !_slowDownRetried) {
        const waitMs = Math.max(100, Number(data?.interval ?? data?.error?.interval ?? 1) * 1000);
        await sleep(waitMs);
        return request(method, path, { body, query, _slowDownRetried: true });
      }

      const transient = res.status === 429 || res.status >= 500;
      if (transient && attempt < maxRetries) {
        attempt += 1;
        const retryAfter = Number(res.headers.get('retry-after'));
        await sleep(Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 2 ** attempt * 500);
        continue;
      }

      throw toError(res.status, data, `${method} ${path} failed`);
    }
  }

  return {
    /**
     * Start a vault session. Omit both ids for an open session (new user).
     * `externalUserId` lets a returning user unlock their vault with a passkey.
     * `userId` (an AgentCard user id) makes a connected session.
     */
    createVaultSession({ externalUserId, userId, steps, expiresIn } = {}) {
      const body = {};
      if (externalUserId) body.external_user_id = externalUserId;
      if (userId) body.user_id = userId;
      if (steps) body.steps = steps;
      if (expiresIn) body.expires_in = expiresIn;
      return request('POST', '/vault_sessions', { body });
    },

    getVaultSession(id) {
      return request('GET', `/vault_sessions/${encodeURIComponent(id)}`);
    },

    /** Display fields only: id, brand, last4, expiry. Card data is never returned. */
    listVaultCards(userId) {
      return request('GET', '/vault_cards', { query: { user_id: userId } });
    },

    createPreparation(fields) {
      return request('POST', '/checkout/preparations', { body: fields });
    },

    createAuthorization(fields) {
      return request('POST', '/checkout/authorizations', { body: fields });
    },

    getAuthorization(id) {
      return request('GET', `/checkout/authorizations/${encodeURIComponent(id)}`);
    },

    cancelAuthorization(id) {
      return request('POST', `/checkout/authorizations/${encodeURIComponent(id)}/cancel`, { body: {} });
    },

    createWebhookEndpoint({ url, enabledEvents, description }) {
      const body = { url, enabled_events: enabledEvents };
      if (description) body.description = description;
      return request('POST', '/webhook_endpoints', { body });
    },

    getWebhookSecret(endpointId) {
      return request('GET', `/webhook_endpoints/${encodeURIComponent(endpointId)}/secret`);
    },

    /** Exposed for tests and for forcing a refresh. */
    _resetToken() {
      token = null;
    },
  };
}

async function readBody(res) {
  const text = await res.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text.slice(0, 200) };
  }
}

function toError(status, body, fallback) {
  const code = body?.error?.code ?? body?.code ?? null;
  const serverMessage = typeof body?.error?.message === 'string' ? body.error.message : null;
  const retryable = status === 429 || status >= 500;
  const message = serverMessage ? `${fallback}: ${serverMessage}` : `${fallback} (HTTP ${status})`;
  return new AgentCardError(message, { status, code, retryable });
}
