/**
 * Webhook receiver for AgentCard events.
 *
 * Rules (AgentCard "Webhooks" docs):
 * - Verify `AgentCard-Signature` against the raw body. Reject stale timestamps.
 * - Delivery is at least once. De-duplicate on the event `id`.
 * - Answer 2xx quickly. Failed deliveries are retried by AgentCard
 *   (up to 5 times), so a failed handler returns 500 and releases the event id.
 *
 * `createWebhookHandler` is framework-free and takes headers and the raw body.
 * `createNodeRoute` adapts it to Node's http, for Express or a bare server.
 */
import { verifyWebhookSignature } from './webhook.js';

const SIGNATURE_HEADER = 'agentcard-signature';

/**
 * @param {{
 *   secret: string,
 *   store: ReturnType<import('./store.js').createMemoryStore>,
 *   enrolment: ReturnType<import('./enrolment.js').createEnrolment>,
 *   purchases: ReturnType<import('./purchases.js').createPurchases>,
 *   onEvent?: (event: object) => void,   // optional audit hook
 *   now?: () => number,
 * }} deps
 */
export function createWebhookHandler({ secret, store, enrolment, purchases, onEvent, now }) {
  if (!secret) throw new Error('webhook secret is required');

  async function dispatch(event) {
    const { type, data = {} } = event;
    if (type === 'vault.session_linked') {
      enrolment.complete(data.vault_session_id, data.user_id);
    } else if (type === 'vault.card_stored') {
      enrolment.recordCardStored(data.user_id ?? null, data);
    } else if (type.startsWith('checkout_authorization.')) {
      purchases.applyWebhookEvent(event);
    }
    // Other event families (orders, cards, transactions, wallet) are accepted
    // and ignored until a feature needs them.
    if (onEvent) onEvent(event);
  }

  /**
   * @param {{ headers: Record<string, string | string[] | undefined>, rawBody: string | Buffer }} request
   * @returns {Promise<{ status: number, body: object }>}
   */
  return async function handle({ headers, rawBody }) {
    const header = headers?.[SIGNATURE_HEADER];
    const ok = verifyWebhookSignature({
      header: Array.isArray(header) ? header[0] : header,
      rawBody,
      secret,
      now: now ? Math.floor(now() / 1000) : undefined,
    });
    if (!ok) return { status: 401, body: { error: 'invalid_signature' } };

    let event;
    try {
      event = JSON.parse(Buffer.isBuffer(rawBody) ? rawBody.toString('utf8') : String(rawBody));
    } catch {
      return { status: 400, body: { error: 'invalid_json' } };
    }
    if (!event?.id || typeof event.type !== 'string') {
      return { status: 400, body: { error: 'missing_id_or_type' } };
    }

    if (!store.markEventSeen(event.id)) {
      return { status: 200, body: { received: true, duplicate: true } };
    }

    try {
      await dispatch(event);
      return { status: 200, body: { received: true } };
    } catch (err) {
      store.unmarkEvent(event.id);
      return { status: 500, body: { error: 'handler_failed', eventType: event.type } };
    }
  };
}

/**
 * Node http route. Reads the raw body (no JSON re-serialisation) and replies.
 * @param {ReturnType<typeof createWebhookHandler>} handle
 */
export function createNodeRoute(handle) {
  return (req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('error', () => {
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'bad_request' }));
    });
    req.on('end', async () => {
      const rawBody = Buffer.concat(chunks);
      const result = await handle({ headers: req.headers, rawBody });
      res.writeHead(result.status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(result.body));
    });
  };
}
