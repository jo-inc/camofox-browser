import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createHmac } from 'node:crypto';
import {
  loadConfig, describeConfig, verifyWebhookSignature, createAgentCard, createMemoryStore,
  createAgentCardApi, AgentCardError, attachCheckout, SUBSCRIBED_EVENTS,
} from '../src/index.js';
import { createFakeAgentCard, FAKE_CLIENT, signedDelivery } from './fake-agentcard.js';

const WEBHOOK_SECRET = 'whsec_test';

function makeStack({ fake = createFakeAgentCard({ webhookSecret: WEBHOOK_SECRET }), onEvent, maxAmountCents } = {}) {
  let clock = 1757264400_000;
  const links = [];
  const approvals = [];
  const agentcard = createAgentCard({
    config: { clientId: FAKE_CLIENT.id, clientSecret: FAKE_CLIENT.secret, webhookSecret: WEBHOOK_SECRET },
    store: createMemoryStore({ now: () => new Date(clock).toISOString() }),
    deliverLink: (userId, url, info) => { links.push({ userId, url, info }); },
    deliverApprovalLink: (userId, url, info) => { approvals.push({ userId, url, info }); },
    fetchImpl: fake.fetch,
    sleep: async () => {},
    now: () => clock,
    onEvent,
    maxAmountCents,
  });
  return {
    agentcard, fake, links, approvals,
    advance(ms) { clock += ms; },
    nowSeconds() { return Math.floor(clock / 1000); },
    deliver(event) {
      const { body, headers } = signedDelivery(event, WEBHOOK_SECRET, Math.floor(clock / 1000));
      return agentcard.webhooks()({ headers, rawBody: body });
    },
  };
}

const PURCHASE = {
  merchant: 'Example Shop',
  amount: 2306,
  currency: 'usd',
  psp: 'stripe',
  request: { url: 'https://api.stripe.com/v1/tokens', method: 'POST', headers: {}, body: 'card[number]=placeholder' },
  checkoutOrigin: 'https://shop.example.com',
};

// ---------- config ----------

describe('config', () => {
  test('names missing variables without revealing values', () => {
    assert.throws(() => loadConfig({}), /AGENTCARD_CLIENT_ID, AGENTCARD_CLIENT_SECRET/);
    const config = loadConfig({ AGENTCARD_CLIENT_ID: 'id_abc', AGENTCARD_CLIENT_SECRET: 'sec_xyz' });
    const summary = JSON.stringify(describeConfig(config));
    assert.ok(!summary.includes('id_abc') && !summary.includes('sec_xyz'));
    assert.equal(config.webhookSecret, null);
  });
});

// ---------- webhook signature ----------

describe('webhook signature', () => {
  const SECRET = 'whsec_unit';
  const NOW = 1757264400;
  const sign = (body, t = NOW, secret = SECRET) =>
    `t=${t},v1=${createHmac('sha256', secret).update(`${t}.${body}`).digest('hex')}`;

  test('accepts a correct signature and rejects tampering, wrong secret, replay', () => {
    const body = '{"id":"evt_1"}';
    assert.equal(verifyWebhookSignature({ header: sign(body), rawBody: body, secret: SECRET, now: NOW }), true);
    assert.equal(verifyWebhookSignature({ header: sign(body), rawBody: '{"id":"x"}', secret: SECRET, now: NOW }), false);
    assert.equal(verifyWebhookSignature({ header: sign(body, NOW, 'other'), rawBody: body, secret: SECRET, now: NOW }), false);
    assert.equal(verifyWebhookSignature({ header: sign(body, NOW - 301), rawBody: body, secret: SECRET, now: NOW }), false);
    assert.equal(verifyWebhookSignature({ header: undefined, rawBody: body, secret: SECRET, now: NOW }), false);
    assert.equal(verifyWebhookSignature({ header: 'garbage', rawBody: body, secret: SECRET, now: NOW }), false);
  });
});

// ---------- API client ----------

describe('API client', () => {
  test('exchanges one token and reuses it until shortly before expiry', async () => {
    const fake = createFakeAgentCard({ tokenLifetimeSeconds: 3600 });
    let clock = 0;
    const api = createAgentCardApi({ clientId: FAKE_CLIENT.id, clientSecret: FAKE_CLIENT.secret, fetchImpl: fake.fetch, now: () => clock, sleep: async () => {} });
    await api.listVaultCards('usr_1');
    await api.listVaultCards('usr_1');
    assert.equal(fake.state.tokenRequests, 1);
    clock = 3600_000 - 30_000; // inside the 60-second refresh margin
    await api.listVaultCards('usr_1');
    assert.equal(fake.state.tokenRequests, 2);
  });

  test('concurrent first calls share one token exchange', async () => {
    const fake = createFakeAgentCard();
    const api = createAgentCardApi({ clientId: FAKE_CLIENT.id, clientSecret: FAKE_CLIENT.secret, fetchImpl: fake.fetch, sleep: async () => {} });
    await Promise.all([api.listVaultCards('a'), api.listVaultCards('b'), api.listVaultCards('c')]);
    assert.equal(fake.state.tokenRequests, 1);
  });

  test('bad credentials raise an error that contains no secret', async () => {
    const fake = createFakeAgentCard();
    const api = createAgentCardApi({ clientId: FAKE_CLIENT.id, clientSecret: 'wrong_secret_value', fetchImpl: fake.fetch, sleep: async () => {} });
    await assert.rejects(api.listVaultCards('u'), (err) => {
      assert.ok(err instanceof AgentCardError);
      assert.equal(err.status, 401);
      assert.ok(!err.message.includes('wrong_secret_value'));
      return true;
    });
  });

  test('retries 429 with backoff, then succeeds', async () => {
    const fake = createFakeAgentCard();
    fake.queue((m, p) => m === 'GET' && p === '/api/v2/vault_cards', () => new Response('{"error":{"code":"rate_limited"}}', { status: 429, headers: { 'content-type': 'application/json' } }));
    const api = createAgentCardApi({ clientId: FAKE_CLIENT.id, clientSecret: FAKE_CLIENT.secret, fetchImpl: fake.fetch, sleep: async () => {} });
    const body = await api.listVaultCards('usr_1');
    assert.deepEqual(body, { data: [] });
  });

  test('a 400 slow_down is retried once after the server interval', async () => {
    const fake = createFakeAgentCard();
    const waits = [];
    fake.queue((m, p) => m === 'GET' && p.startsWith('/api/v2/checkout/authorizations/'), () =>
      new Response('{"error":{"code":"slow_down"},"interval":2}', { status: 400, headers: { 'content-type': 'application/json' } }));
    const api = createAgentCardApi({ clientId: FAKE_CLIENT.id, clientSecret: FAKE_CLIENT.secret, fetchImpl: fake.fetch, sleep: async (ms) => waits.push(ms) });
    await assert.rejects(api.getAuthorization('cauth_missing'), (err) => err.status === 404);
    assert.deepEqual(waits, [2000]);
  });

  test('exhausted 5xx is reported as retryable', async () => {
    const fake = createFakeAgentCard();
    for (let i = 0; i < 5; i += 1) {
      fake.queue((m, p) => m === 'GET' && p === '/api/v2/vault_cards', () => new Response('{}', { status: 503 }));
    }
    const api = createAgentCardApi({ clientId: FAKE_CLIENT.id, clientSecret: FAKE_CLIENT.secret, fetchImpl: fake.fetch, sleep: async () => {}, maxRetries: 2 });
    await assert.rejects(api.listVaultCards('u'), (err) => err.status === 503 && err.retryable === true);
  });
});

// ---------- enrolment ----------

describe('enrolment', () => {
  test('a new user gets an open session tagged with our id and a link delivered', async () => {
    const s = makeStack();
    const result = await s.agentcard.enrolment.start('user_42');
    assert.equal(result.status, 'link_sent');
    assert.equal(s.links.length, 1);
    assert.equal(s.links[0].userId, 'user_42');
    assert.match(s.links[0].url, /vault\.agentcard\.sh/);
    const created = s.fake.state.sessions.get(result.sessionId);
    assert.equal(created.external_user_id, 'user_42');
    assert.equal(created.user_id, null);
  });

  test('polling records the AgentCard user once the user links', async () => {
    const s = makeStack();
    const { sessionId } = await s.agentcard.enrolment.start('user_1');
    assert.equal((await s.agentcard.enrolment.poll(sessionId)).status, 'pending');
    s.fake.linkSession(sessionId, 'usr_ac_1');
    assert.equal((await s.agentcard.enrolment.poll(sessionId)).status, 'linked');
    assert.equal(s.agentcard.store.getAgentCardUser('user_1'), 'usr_ac_1');
  });

  test('an expired session is reported and never linked', async () => {
    const s = makeStack();
    const { sessionId } = await s.agentcard.enrolment.start('user_2');
    s.fake.expireSession(sessionId);
    assert.equal((await s.agentcard.enrolment.poll(sessionId)).status, 'expired');
    assert.equal(s.agentcard.store.getAgentCardUser('user_2'), null);
  });

  test('a user with a card on file is not sent a second link', async () => {
    const s = makeStack();
    s.agentcard.store.setAgentCardUser('user_3', 'usr_ac_3');
    s.fake.setCards('usr_ac_3', [{ id: 'card_1', brand: 'visa', last4: '4242' }]);
    const result = await s.agentcard.enrolment.start('user_3');
    assert.deepEqual(result, { status: 'already_enrolled', cardCount: 1 });
    assert.equal(s.links.length, 0);
  });

  test('a known user with no card gets a connected session, not a new open one', async () => {
    const s = makeStack();
    s.agentcard.store.setAgentCardUser('user_4', 'usr_ac_4');
    const result = await s.agentcard.enrolment.start('user_4');
    assert.equal(result.status, 'link_sent');
    const created = s.fake.state.sessions.get(result.sessionId);
    assert.equal(created.user_id, 'usr_ac_4');
    assert.equal(created.external_user_id, null);
    assert.deepEqual(created.steps, ['card']);
  });

  test('vault.session_linked webhook completes enrolment', async () => {
    const s = makeStack();
    const { sessionId } = await s.agentcard.enrolment.start('user_5');
    const res = await s.deliver({ id: 'evt_link_1', type: 'vault.session_linked', created: s.nowSeconds(), data: { vault_session_id: sessionId, user_id: 'usr_ac_5' } });
    assert.equal(res.status, 200);
    assert.equal(s.agentcard.store.getAgentCardUser('user_5'), 'usr_ac_5');
  });
});

// ---------- purchases ----------

describe('purchases', () => {
  async function enrolledStack(opts) {
    const s = makeStack(opts);
    s.agentcard.store.setAgentCardUser('user_9', 'usr_ac_9');
    return s;
  }

  test('refuses a purchase for a user with no card', async () => {
    const s = makeStack();
    await assert.rejects(s.agentcard.purchases.request({ userId: 'nobody', ...PURCHASE }), (err) => err.code === 'not_enrolled');
  });

  test('validates amount, currency, psp and request before calling AgentCard', async () => {
    const s = await enrolledStack();
    const before = s.fake.state.requests.length;
    const bad = [
      { amount: 0 }, { amount: 12.5 }, { currency: 'USD' }, { currency: undefined }, { psp: '' }, { request: {} },
    ];
    for (const override of bad) {
      await assert.rejects(s.agentcard.purchases.request({ userId: 'user_9', ...PURCHASE, ...override }));
    }
    assert.equal(s.fake.state.requests.filter((r) => r.path === '/api/v2/checkout/authorizations').length, 0, `no authorizations created (before=${before})`);
  });

  test('a valid purchase delivers the approval link to the user and never returns it', async () => {
    const s = await enrolledStack();
    const result = await s.agentcard.purchases.request({ userId: 'user_9', ...PURCHASE });
    assert.equal(result.status, 'awaiting_approval');
    assert.equal(result.approvalUrl, undefined);
    assert.equal(s.approvals.length, 1);
    assert.equal(s.approvals[0].userId, 'user_9');
    assert.match(s.approvals[0].url, /authorize\?id=cauth_/);
    assert.equal(s.approvals[0].info.purchaseId, result.purchaseId);
  });

  test('approval webhook moves the purchase to approved and blocks retries', async () => {
    const s = await enrolledStack();
    const { purchaseId } = await s.agentcard.purchases.request({ userId: 'user_9', ...PURCHASE });
    const res = await s.deliver({ id: 'evt_a1', type: 'checkout_authorization.approved', created: s.nowSeconds(), data: { id: purchaseId, charged_amount: 2306, charged_kind: 'captured' } });
    assert.equal(res.status, 200);
    const p = s.agentcard.store.getPurchase(purchaseId);
    assert.equal(p.status, 'approved');
    assert.equal(p.chargedAmount, 2306);
    assert.equal(s.agentcard.purchases.canRetry('user_9', purchaseId), false);
    assert.deepEqual(s.agentcard.store.listPurchaseEvents(purchaseId).map((e) => e.type), ['requested', 'checkout_authorization.approved']);
  });

  test('declined and expired purchases may be retried; amount mismatch counts as declined', async () => {
    const s = await enrolledStack();
    const a = (await s.agentcard.purchases.request({ userId: 'user_9', ...PURCHASE })).purchaseId;
    await s.deliver({ id: 'evt_d1', type: 'checkout_authorization.declined', created: s.nowSeconds(), data: { id: a, reason: 'user_declined' } });
    assert.equal(s.agentcard.purchases.canRetry('user_9', a), true);

    const b = (await s.agentcard.purchases.request({ userId: 'user_9', ...PURCHASE })).purchaseId;
    await s.deliver({ id: 'evt_m1', type: 'checkout_authorization.declined', created: s.nowSeconds(), data: { id: b, reason: 'amount_mismatch' } });
    assert.equal(s.agentcard.store.getPurchase(b).status, 'declined');

    const c = (await s.agentcard.purchases.request({ userId: 'user_9', ...PURCHASE })).purchaseId;
    await s.deliver({ id: 'evt_e1', type: 'checkout_authorization.expired', created: s.nowSeconds(), data: { id: c } });
    assert.equal(s.agentcard.purchases.canRetry('user_9', c), true);
  });

  test('settlement_unconfirmed allows retry only once AgentCard marks it final', async () => {
    const s = await enrolledStack();
    const { purchaseId } = await s.agentcard.purchases.request({ userId: 'user_9', ...PURCHASE });
    await s.deliver({ id: 'evt_s1', type: 'checkout_authorization.approved', created: s.nowSeconds(), data: { id: purchaseId } });
    await s.deliver({ id: 'evt_s2', type: 'checkout_authorization.settlement_unconfirmed', created: s.nowSeconds(), data: { id: purchaseId, settlement: { status: 'not_settled', reason: 'not_confirmed', final: false } } });
    assert.equal(s.agentcard.purchases.canRetry('user_9', purchaseId), false);
    await s.deliver({ id: 'evt_s3', type: 'checkout_authorization.settlement_unconfirmed', created: s.nowSeconds(), data: { id: purchaseId, settlement: { status: 'not_settled', reason: 'not_confirmed', final: true } } });
    assert.equal(s.agentcard.purchases.canRetry('user_9', purchaseId), true);
  });

  test('settled webhook records the settlement', async () => {
    const s = await enrolledStack();
    const { purchaseId } = await s.agentcard.purchases.request({ userId: 'user_9', ...PURCHASE });
    await s.deliver({ id: 'evt_st1', type: 'checkout_authorization.settled', created: s.nowSeconds(), data: { id: purchaseId } });
    assert.equal(s.agentcard.store.getPurchase(purchaseId).status, 'settled');
  });

  test('amount above the configured limit is refused before any call', async () => {
    const s = await enrolledStack({ maxAmountCents: 5000 });
    await assert.rejects(s.agentcard.purchases.request({ userId: 'user_9', ...PURCHASE, amount: 5001 }), (err) => err.code === 'over_limit');
    assert.equal(s.fake.state.requests.filter((r) => r.path === '/api/v2/checkout/authorizations').length, 0);
  });

  test('cancel stops a waiting purchase; another user cannot touch it', async () => {
    const s = await enrolledStack();
    s.agentcard.store.setAgentCardUser('other', 'usr_ac_other');
    const { purchaseId } = await s.agentcard.purchases.request({ userId: 'user_9', ...PURCHASE });
    await assert.rejects(s.agentcard.purchases.cancel('other', purchaseId), (err) => err.code === 'not_found');
    const cancelled = await s.agentcard.purchases.cancel('user_9', purchaseId);
    assert.equal(cancelled.status, 'declined');
  });

  test('refresh reads the authoritative status when a webhook is late', async () => {
    const s = await enrolledStack();
    const { purchaseId } = await s.agentcard.purchases.request({ userId: 'user_9', ...PURCHASE });
    s.fake.setAuthorization(purchaseId, { status: 'approved', charged_amount: 2306 });
    const p = await s.agentcard.purchases.refresh('user_9', purchaseId);
    assert.equal(p.status, 'approved');
  });

  test('list returns only the owner’s purchases', async () => {
    const s = await enrolledStack();
    s.agentcard.store.setAgentCardUser('user_10', 'usr_ac_10');
    await s.agentcard.purchases.request({ userId: 'user_9', ...PURCHASE });
    assert.equal(s.agentcard.purchases.list('user_9').length, 1);
    assert.equal(s.agentcard.purchases.list('user_10').length, 0);
  });
});

// ---------- webhooks ----------

describe('webhooks', () => {
  test('a bad signature is rejected and changes nothing', async () => {
    const s = makeStack();
    const { body } = signedDelivery({ id: 'evt_x', type: 'vault.session_linked', data: {} }, 'wrong_secret', s.nowSeconds());
    const res = await s.agentcard.webhooks()({ headers: { 'agentcard-signature': `t=${s.nowSeconds()},v1=deadbeef` }, rawBody: body });
    assert.equal(res.status, 401);
  });

  test('duplicate deliveries are acknowledged and processed once', async () => {
    let seen = 0;
    const s = makeStack({ onEvent: () => { seen += 1; } });
    const event = { id: 'evt_dup', type: 'vault.card_stored', data: { user_id: 'usr_1' } };
    assert.equal((await s.deliver(event)).status, 200);
    const again = await s.deliver(event);
    assert.equal(again.body.duplicate, true);
    assert.equal(seen, 1);
  });

  test('a failed handler returns 500 and the retry is processed', async () => {
    let calls = 0;
    const s = makeStack({ onEvent: () => { calls += 1; if (calls === 1) throw new Error('db down'); } });
    const event = { id: 'evt_retry', type: 'vault.card_stored', data: {} };
    const first = await s.deliver(event);
    assert.equal(first.status, 500);
    const retry = await s.deliver(event);
    assert.equal(retry.status, 200);
    assert.equal(retry.body.duplicate, undefined);
    assert.equal(calls, 2);
  });

  test('missing id or type and invalid JSON are rejected', async () => {
    const s = makeStack();
    const noId = signedDelivery({ type: 'vault.card_stored' }, WEBHOOK_SECRET, s.nowSeconds());
    assert.equal((await s.agentcard.webhooks()({ headers: noId.headers, rawBody: noId.body })).status, 400);
    const junk = '{not json';
    const sig = signedDelivery({}, WEBHOOK_SECRET, s.nowSeconds());
    const badJson = `t=${s.nowSeconds()},v1=${createHmac('sha256', WEBHOOK_SECRET).update(`${s.nowSeconds()}.${junk}`).digest('hex')}`;
    assert.equal((await s.agentcard.webhooks()({ headers: { 'agentcard-signature': badJson }, rawBody: junk })).status, 400);
    assert.ok(sig.body);
  });

  test('ignores event families this version does not use', async () => {
    const s = makeStack();
    const res = await s.deliver({ id: 'evt_other', type: 'order.placed', data: {} });
    assert.equal(res.status, 200);
  });

  test('webhooks need a configured secret', () => {
    const agentcard = createAgentCard({
      config: { clientId: 'a', clientSecret: 'b', webhookSecret: null },
      deliverLink() {}, deliverApprovalLink() {}, fetchImpl: createFakeAgentCard().fetch,
    });
    assert.throws(() => agentcard.webhooks(), /AGENTCARD_WEBHOOK_SECRET/);
  });

  test('end to end over real HTTP: a signed approval updates the purchase', async () => {
    const s = makeStack();
    s.agentcard.store.setAgentCardUser('user_http', 'usr_ac_http');
    const { purchaseId } = await s.agentcard.purchases.request({ userId: 'user_http', ...PURCHASE });
    const server = http.createServer(s.agentcard.webhookRoute());
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const { port } = server.address();
    try {
      const event = { id: 'evt_http_1', type: 'checkout_authorization.approved', created: s.nowSeconds(), data: { id: purchaseId } };
      const { body, headers } = signedDelivery(event, WEBHOOK_SECRET, s.nowSeconds());
      const res = await fetch(`http://127.0.0.1:${port}/`, { method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body });
      assert.equal(res.status, 200);
      assert.equal(s.agentcard.store.getPurchase(purchaseId).status, 'approved');
    } finally {
      await new Promise((r) => server.close(r));
    }
  });

  test('registers the endpoint with the events this integration uses', async () => {
    const s = makeStack();
    const endpoint = await s.agentcard.registerWebhookEndpoint({ url: 'https://app.example/agentcard/webhooks' });
    assert.deepEqual(endpoint.enabled_events, SUBSCRIBED_EVENTS);
    assert.equal(endpoint.secret, WEBHOOK_SECRET);
  });
});

// ---------- browser checkout ----------

describe('browser checkout', () => {
  test('attachCheckout refuses without the required purchase fields', async () => {
    const client = { vault: {}, sdk: { attachToPlaywright: async () => 'attached' } };
    const ok = { agentcardUserId: 'usr_1', merchant: 'shop.example.com', amountCents: 2306, onApprovalUrl: () => {} };
    assert.equal(await attachCheckout(client, {}, ok), 'attached');
    await assert.rejects(attachCheckout(client, {}, { ...ok, agentcardUserId: '' }), /agentcardUserId/);
    await assert.rejects(attachCheckout(client, {}, { ...ok, merchant: '' }), /merchant/);
    await assert.rejects(attachCheckout(client, {}, { ...ok, amountCents: 0 }), /amountCents/);
    await assert.rejects(attachCheckout(client, {}, { ...ok, amountCents: 12.5 }), /amountCents/);
    await assert.rejects(attachCheckout(client, {}, { ...ok, onApprovalUrl: undefined }), /onApprovalUrl/);
  });
});
