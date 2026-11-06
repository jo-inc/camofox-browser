/**
 * Purchases that need the user's approval.
 *
 * Nothing is charged without approval. A purchase starts as an AgentCard
 * checkout authorization. The user receives an approval link and approves on
 * their own device. We act on webhook events and on status reads, never on what
 * an agent reports.
 *
 * Retry rule (AgentCard docs): a purchase is retried only when the merchant or
 * the processor confirms it failed. An approved or submitted purchase is never
 * retried, because that could charge the user twice.
 */

const EVENT_STATUS = {
  approved: 'approved',
  submitted: 'submitted',
  declined: 'declined',
  amount_mismatch: 'declined',
  expired: 'expired',
  refused: 'refused',
  settled: 'settled',
  settlement_unconfirmed: 'not_settled',
};

const RETRYABLE_STATUSES = new Set(['declined', 'expired', 'refused']);
const SAFE_CURRENCY = /^[a-z]{3}$/;

/**
 * @param {{
 *   api: ReturnType<import('./api.js').createAgentCardApi>,
 *   store: ReturnType<import('./store.js').createMemoryStore>,
 *   deliverApprovalLink: (userId: string, url: string, info: { purchaseId: string, merchant: string, amount: number, currency: string, expiresAt: string | null }) => Promise<void> | void,
 *   maxAmountCents?: number,       // optional cap; purchases above it are refused
 *   now?: () => string,
 * }} deps
 */
export function createPurchases({ api, store, deliverApprovalLink, maxAmountCents = null, now = () => new Date().toISOString() }) {
  function ownedPurchase(userId, id) {
    const purchase = store.getPurchase(id);
    if (!purchase || purchase.userId !== userId) {
      const err = new Error('Purchase not found');
      err.code = 'not_found';
      throw err;
    }
    return purchase;
  }

  function applyStatus(id, patch, eventType) {
    const updated = store.updatePurchase(id, patch);
    store.appendPurchaseEvent(id, { type: eventType, status: patch.status ?? null });
    return updated;
  }

  return {
    /**
     * Request one purchase. The approval link goes to the user through
     * deliverApprovalLink. It is never returned to the caller or the model.
     *
     * @param {{
     *   userId: string,
     *   merchant: string,
     *   amount: number,            // smallest currency unit, integer
     *   currency: string,          // ISO 4217, lowercase, e.g. "usd"
     *   psp: string,               // e.g. "stripe"
     *   request: { url: string, method: string, headers?: object, body?: string },
     *   checkoutOrigin?: string,   // https://shop.example.com, no path
     *   cardId?: string,
     * }} input
     */
    async request(input) {
      const { userId, merchant, amount, currency, psp, request, checkoutOrigin, cardId } = input;
      const agentcardUserId = store.getAgentCardUser(userId);
      if (!agentcardUserId) {
        const err = new Error('This user has no card on file. Send an enrolment link first.');
        err.code = 'not_enrolled';
        throw err;
      }
      if (!merchant) throw new Error('merchant is required');
      if (!Number.isInteger(amount) || amount <= 0) throw new Error('amount must be a positive integer in the smallest unit');
      if (!SAFE_CURRENCY.test(currency ?? '')) throw new Error('currency must be a 3-letter ISO code');
      if (!psp) throw new Error('psp is required');
      if (!request?.url || !request?.method) throw new Error('request.url and request.method are required');
      if (maxAmountCents !== null && amount > maxAmountCents) {
        const err = new Error('Purchase is above the configured limit');
        err.code = 'over_limit';
        throw err;
      }

      const auth = await api.createAuthorization({
        user: agentcardUserId,
        merchant,
        amount,
        currency,
        psp,
        request,
        checkout_origin: checkoutOrigin,
        card_id: cardId,
      });

      const at = now();
      store.putPurchase({
        id: auth.id,
        userId,
        merchant,
        amount,
        currency,
        status: auth.status ?? 'awaiting_approval',
        settlement: null,
        createdAt: at,
        updatedAt: at,
      });
      store.appendPurchaseEvent(auth.id, { type: 'requested', status: auth.status ?? 'awaiting_approval' });

      await deliverApprovalLink(userId, auth.approvalUrl, {
        purchaseId: auth.id,
        merchant,
        amount,
        currency,
        expiresAt: auth.expires_at ?? auth.expiresAt ?? null,
      });

      return { purchaseId: auth.id, status: auth.status ?? 'awaiting_approval', expiresAt: auth.expires_at ?? null };
    },

    /** Cancel while awaiting approval. Safe to call again. */
    async cancel(userId, id) {
      ownedPurchase(userId, id);
      const result = await api.cancelAuthorization(id);
      return applyStatus(id, { status: result.status ?? 'declined' }, 'cancelled');
    },

    /** Read the authoritative status from AgentCard (use when a webhook is late). */
    async refresh(userId, id) {
      ownedPurchase(userId, id);
      const auth = await api.getAuthorization(id);
      const settlement = auth.settlement ?? null;
      return applyStatus(
        id,
        {
          status: auth.status,
          settlement,
          chargedAmount: auth.charged_amount ?? null,
          chargedKind: auth.charged_kind ?? null,
        },
        'refreshed',
      );
    },

    /**
     * Apply one verified checkout_authorization.* webhook event.
     * @param {{ type: string, data?: object }} event
     */
    applyWebhookEvent(event) {
      const id = event.data?.id;
      if (!id) return null;
      const purchase = store.getPurchase(id);
      if (!purchase) return null; // not a purchase we created

      const kind = event.type.replace(/^checkout_authorization\./, '');
      if (kind === 'watched') {
        store.appendPurchaseEvent(id, { type: event.type });
        return purchase;
      }

      const status = EVENT_STATUS[kind];
      if (!status) return purchase;

      const patch = { status };
      if (status === 'settled' || status === 'not_settled') {
        patch.settlement = event.data?.settlement ?? { status: status === 'settled' ? 'settled' : 'not_settled' };
      }
      if (event.data?.charged_amount !== undefined) patch.chargedAmount = event.data.charged_amount;
      if (event.data?.charged_kind !== undefined) patch.chargedKind = event.data.charged_kind;
      return applyStatus(id, patch, event.type);
    },

    /** True only when a retry is safe: the purchase failed and nothing was charged. */
    canRetry(userId, id) {
      const purchase = ownedPurchase(userId, id);
      if (RETRYABLE_STATUSES.has(purchase.status)) return true;
      return purchase.settlement?.status === 'not_settled' && purchase.settlement?.final === true;
    },

    list(userId) {
      return store.listPurchases(userId);
    },
  };
}
