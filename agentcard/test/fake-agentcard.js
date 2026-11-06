/**
 * In-process fake of the AgentCard API, for tests only.
 *
 * It implements the endpoints and statuses documented in the AgentCard API
 * reference, and enforces bearer auth. It is a test double, not a copy of the
 * service. Its behaviour follows the docs; field shapes that the docs leave
 * unverified are marked in the modules, and must be confirmed in sandbox.
 */
import { createHmac } from 'node:crypto';

export const FAKE_CLIENT = { id: 'cli_test', secret: 'sec_test' };

export function createFakeAgentCard({ webhookSecret = 'whsec_test', tokenLifetimeSeconds = 3600 } = {}) {
  let tokenSeq = 0;
  let idSeq = 0;
  const state = {
    tokens: new Set(),
    tokenRequests: 0,
    sessions: new Map(), // id -> { status, user_id, external_user_id }
    cards: new Map(), // user_id -> [card]
    authorizations: new Map(), // id -> { ...auth }
    endpoints: [],
    requests: [], // { method, path }
    queueResponses: [], // one-shot overrides: { match: (method, path) => bool, respond: () => Response }
  };

  const json = (status, body, headers = {}) =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

  const nowIso = () => new Date(Date.now() + 15 * 60_000).toISOString();

  async function handler(input, init = {}) {
    const url = new URL(typeof input === 'string' ? input : input.url);
    const method = (init.method ?? 'GET').toUpperCase();
    const path = url.pathname;
    state.requests.push({ method, path });

    const queued = state.queueResponses.findIndex((q) => q.match(method, path));
    if (queued >= 0) {
      const [q] = state.queueResponses.splice(queued, 1);
      return q.respond();
    }

    if (method === 'POST' && path === '/api/v2/oauth/token') {
      const form = new URLSearchParams(init.body);
      if (form.get('client_id') !== FAKE_CLIENT.id || form.get('client_secret') !== FAKE_CLIENT.secret) {
        return json(401, { error: { code: 'invalid_client', message: 'Bad credentials' } });
      }
      state.tokenRequests += 1;
      const value = `tok_${++tokenSeq}`;
      state.tokens.add(value);
      return json(200, { access_token: value, token_type: 'Bearer', expires_in: tokenLifetimeSeconds, scope: 'api' });
    }

    const auth = (init.headers ?? {});
    const bearer = (auth.authorization ?? auth.Authorization ?? '').replace(/^Bearer /, '');
    if (!state.tokens.has(bearer)) return json(401, { error: { code: 'unauthorized', message: 'Missing or invalid token' } });

    if (method === 'POST' && path === '/api/v2/vault_sessions') {
      const body = JSON.parse(init.body ?? '{}');
      const id = `vs_${++idSeq}`;
      state.sessions.set(id, {
        status: 'pending',
        user_id: body.user_id ?? null,
        external_user_id: body.external_user_id ?? null,
        steps: body.steps ?? null,
      });
      return json(201, {
        object: 'vault_session',
        id,
        user_id: body.user_id ?? null,
        url: `https://vault.agentcard.sh/sign-in?vs=${id}`,
        poll_interval: 3,
        expires_at: nowIso(),
        test_mode: true,
      });
    }

    const sessionMatch = path.match(/^\/api\/v2\/vault_sessions\/([^/]+)$/);
    if (method === 'GET' && sessionMatch) {
      const s = state.sessions.get(sessionMatch[1]);
      if (!s) return json(404, { error: { code: 'not_found', message: 'No such session' } });
      return json(200, { id: sessionMatch[1], object: 'vault_session', ...s });
    }

    if (method === 'GET' && path === '/api/v2/vault_cards') {
      const userId = url.searchParams.get('user_id');
      return json(200, { data: state.cards.get(userId) ?? [] });
    }

    if (method === 'POST' && path === '/api/v2/checkout/authorizations') {
      const body = JSON.parse(init.body ?? '{}');
      const id = `cauth_${++idSeq}`;
      const record = {
        id,
        object: 'checkout_authorization',
        user: body.user,
        merchant: body.merchant,
        amount: body.amount ?? null,
        currency: body.currency ?? null,
        status: 'awaiting_approval',
        settlement: null,
        approvalUrl: `https://vault.agentcard.sh/authorize?id=${id}`,
        expires_at: nowIso(),
        poll_interval_ms: 2000,
      };
      state.authorizations.set(id, record);
      return json(201, record);
    }

    const authMatch = path.match(/^\/api\/v2\/checkout\/authorizations\/([^/]+)(\/cancel)?$/);
    if (authMatch) {
      const rec = state.authorizations.get(authMatch[1]);
      if (!rec) return json(404, { error: { code: 'not_found', message: 'No such authorization' } });
      if (method === 'POST' && authMatch[2]) {
        if (rec.status === 'awaiting_approval') rec.status = 'declined';
        return json(200, { id: rec.id, status: rec.status, reason: 'merchant_request_aborted', cancelled: true });
      }
      if (method === 'GET') return json(200, rec);
    }

    if (method === 'POST' && path === '/api/v2/webhook_endpoints') {
      const body = JSON.parse(init.body ?? '{}');
      const endpoint = { id: `we_${++idSeq}`, object: 'webhook_endpoint', url: body.url, enabled_events: body.enabled_events, status: 'active', secret: webhookSecret };
      state.endpoints.push(endpoint);
      return json(201, endpoint);
    }

    const secretMatch = path.match(/^\/api\/v2\/webhook_endpoints\/([^/]+)\/secret$/);
    if (method === 'GET' && secretMatch) {
      return json(200, { id: secretMatch[1], secret: webhookSecret });
    }

    return json(404, { error: { code: 'not_found', message: `No route for ${method} ${path}` } });
  }

  return {
    fetch: handler,
    state,
    /** Make the next matching request return a custom response. */
    queue(match, respond) {
      state.queueResponses.push({ match, respond });
    },
    /** Set a card on file for an AgentCard user. */
    setCards(userId, cards) {
      state.cards.set(userId, cards);
    },
    /** Simulate the user finishing the vault page. */
    linkSession(sessionId, userId) {
      const s = state.sessions.get(sessionId);
      if (s) {
        s.status = 'linked';
        s.user_id = userId;
      }
    },
    expireSession(sessionId) {
      const s = state.sessions.get(sessionId);
      if (s) s.status = 'expired';
    },
    /** Move an authorization to a new state, as AgentCard would after a user action. */
    setAuthorization(id, patch) {
      const rec = state.authorizations.get(id);
      if (rec) Object.assign(rec, patch);
      return rec;
    },
  };
}

/** Build a signed webhook delivery exactly as AgentCard sends it. */
export function signedDelivery(event, secret = 'whsec_test', t = Math.floor(Date.now() / 1000)) {
  const body = JSON.stringify(event);
  const v1 = createHmac('sha256', secret).update(`${t}.${body}`).digest('hex');
  return { body, headers: { 'agentcard-signature': `t=${t},v1=${v1}` } };
}
