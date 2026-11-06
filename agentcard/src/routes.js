/**
 * Express routes for the AgentCard integration.
 *
 * Every user-facing route takes its user from `resolveUser(req)`, which the
 * calling system sets from its own authenticated session. The user id is
 * never read from the request body or query string. This follows the Camofox
 * rule that userId is set by the caller, not by the user's text.
 *
 * Responses never include approval links, card data, tokens or secrets.
 * The approval link goes to the user through `deliverApprovalLink`.
 *
 * Mount (after review, see agentcard/README.md):
 *   app.use('/agentcard', createAgentCardRouter({ agentcard, express, resolveUser }));
 * The webhook route reads the raw body itself, so it must sit ahead of any
 * global JSON parser that would re-serialise it.
 */
import { AgentCardError } from './api.js';

function safePurchase(p) {
  return {
    purchaseId: p.id,
    merchant: p.merchant,
    amount: p.amount,
    currency: p.currency,
    status: p.status,
    settlementStatus: p.settlement?.status ?? null,
    updatedAt: p.updatedAt,
  };
}

function sendError(res, err) {
  if (err?.code === 'not_found') return res.status(404).json({ error: 'not_found' });
  if (err?.code === 'not_enrolled') return res.status(409).json({ error: 'not_enrolled', message: err.message });
  if (err?.code === 'over_limit') return res.status(422).json({ error: 'over_limit', message: err.message });
  if (err instanceof AgentCardError) {
    return res.status(502).json({ error: 'agentcard_unavailable', retryable: err.retryable });
  }
  if (err && /required|must be|needs/.test(err.message)) {
    return res.status(400).json({ error: 'invalid_request', message: err.message });
  }
  return res.status(500).json({ error: 'internal_error' });
}

/**
 * @param {{
 *   agentcard: ReturnType<import('./service.js').createAgentCard>,
 *   express: typeof import('express'),
 *   resolveUser: (req: import('express').Request) => string | null,
 * }} deps
 */
export function createAgentCardRouter({ agentcard, express, resolveUser }) {
  const router = express.Router();

  function userOr401(req, res) {
    const userId = resolveUser(req);
    if (!userId) {
      res.status(401).json({ error: 'unauthenticated' });
      return null;
    }
    return userId;
  }

  // Start enrolment: the user gets a link to save or unlock their card.
  router.post('/enrolment', express.json({ limit: '4kb' }), async (req, res) => {
    const userId = userOr401(req, res);
    if (!userId) return;
    try {
      const result = await agentcard.enrolment.start(userId, { replaceCard: req.body?.replaceCard === true });
      res.status(result.status === 'link_sent' ? 201 : 200).json(result);
    } catch (err) {
      sendError(res, err);
    }
  });

  // Poll one enrolment session. Only its owner can read it.
  router.get('/enrolment/:sessionId', async (req, res) => {
    const userId = userOr401(req, res);
    if (!userId) return;
    const session = agentcard.store.getEnrolment(req.params.sessionId);
    if (!session || session.userId !== userId) return res.status(404).json({ error: 'not_found' });
    try {
      res.json(await agentcard.enrolment.poll(req.params.sessionId));
    } catch (err) {
      sendError(res, err);
    }
  });

  // Request a purchase. The approval link goes to the user, not back here.
  router.post('/purchases', express.json({ limit: '64kb' }), async (req, res) => {
    const userId = userOr401(req, res);
    if (!userId) return;
    const b = req.body ?? {};
    try {
      const result = await agentcard.purchases.request({
        userId,
        merchant: b.merchant,
        amount: b.amount,
        currency: b.currency,
        psp: b.psp,
        request: b.request,
        checkoutOrigin: b.checkoutOrigin,
        cardId: b.cardId,
      });
      res.status(201).json(result);
    } catch (err) {
      sendError(res, err);
    }
  });

  router.get('/purchases', (req, res) => {
    const userId = userOr401(req, res);
    if (!userId) return;
    res.json({ purchases: agentcard.purchases.list(userId).map(safePurchase) });
  });

  router.get('/purchases/:id', (req, res) => {
    const userId = userOr401(req, res);
    if (!userId) return;
    const p = agentcard.store.getPurchase(req.params.id);
    if (!p || p.userId !== userId) return res.status(404).json({ error: 'not_found' });
    res.json({
      ...safePurchase(p),
      chargedAmount: p.chargedAmount ?? null,
      canRetry: agentcard.purchases.canRetry(userId, p.id),
      events: agentcard.store.listPurchaseEvents(p.id).map((e) => ({ type: e.type, status: e.status ?? null, at: e.at })),
    });
  });

  router.post('/purchases/:id/cancel', async (req, res) => {
    const userId = userOr401(req, res);
    if (!userId) return;
    try {
      res.json(safePurchase(await agentcard.purchases.cancel(userId, req.params.id)));
    } catch (err) {
      sendError(res, err);
    }
  });

  router.post('/purchases/:id/refresh', async (req, res) => {
    const userId = userOr401(req, res);
    if (!userId) return;
    try {
      res.json(safePurchase(await agentcard.purchases.refresh(userId, req.params.id)));
    } catch (err) {
      sendError(res, err);
    }
  });

  // Webhooks: AgentCard calls this, not a user. Signature is checked on the raw body.
  router.post('/webhooks', express.raw({ type: '*/*', limit: '256kb' }), async (req, res) => {
    let handle;
    try {
      handle = agentcard.webhooks();
    } catch {
      return res.status(503).json({ error: 'webhooks_not_configured' });
    }
    const result = await handle({ headers: req.headers, rawBody: req.body ?? Buffer.alloc(0) });
    res.status(result.status).json(result.body);
  });

  return router;
}
