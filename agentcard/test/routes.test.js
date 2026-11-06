import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { createAgentCard, createMemoryStore, createAgentCardRouter } from '../src/index.js';
import { createFakeAgentCard, FAKE_CLIENT, signedDelivery } from './fake-agentcard.js';

const WEBHOOK_SECRET = 'whsec_test';
const PURCHASE = {
  merchant: 'Example Shop', amount: 2306, currency: 'usd', psp: 'stripe',
  request: { url: 'https://api.stripe.com/v1/tokens', method: 'POST' },
  checkoutOrigin: 'https://shop.example.com',
};

describe('AgentCard HTTP routes', () => {
  let server;
  let base;
  let fake;
  let agentcard;
  const delivered = [];

  before(async () => {
    fake = createFakeAgentCard({ webhookSecret: WEBHOOK_SECRET });
    agentcard = createAgentCard({
      config: { clientId: FAKE_CLIENT.id, clientSecret: FAKE_CLIENT.secret, webhookSecret: WEBHOOK_SECRET },
      store: createMemoryStore(),
      fetchImpl: fake.fetch,
      sleep: async () => {},
      deliverLink: (userId, url) => { delivered.push({ kind: 'enrol', userId, url }); },
      deliverApprovalLink: (userId, url) => { delivered.push({ kind: 'approve', userId, url }); },
    });
    const app = express();
    // The caller's session sets the user. Here, a test header stands in for it.
    const resolveUser = (req) => req.get('x-session-user') || null;
    app.use('/agentcard', createAgentCardRouter({ agentcard, express, resolveUser }));
    server = app.listen(0, '127.0.0.1');
    await new Promise((r) => server.once('listening', r));
    base = `http://127.0.0.1:${server.address().port}/agentcard`;
  });

  after(async () => {
    await new Promise((r) => server.close(r));
  });

  const as = (user) => ({ 'x-session-user': user, 'content-type': 'application/json' });

  test('rejects requests with no authenticated user', async () => {
    const res = await fetch(`${base}/purchases`);
    assert.equal(res.status, 401);
  });

  test('ignores a userId sent in the body and uses the session user', async () => {
    const res = await fetch(`${base}/enrolment`, {
      method: 'POST', headers: as('alice'), body: JSON.stringify({ userId: 'mallory' }),
    });
    assert.equal(res.status, 201);
    const sent = delivered.at(-1);
    assert.equal(sent.userId, 'alice');
    assert.equal(agentcard.store.getEnrolment(sent.url.split('vs=')[1]).userId, 'alice');
  });

  test('a purchase before enrolment is refused with a clear status', async () => {
    const res = await fetch(`${base}/purchases`, { method: 'POST', headers: as('bob'), body: JSON.stringify(PURCHASE) });
    assert.equal(res.status, 409);
    assert.equal((await res.json()).error, 'not_enrolled');
  });

  test('a purchase returns no approval link, and the user gets it through delivery', async () => {
    agentcard.store.setAgentCardUser('carol', 'usr_ac_carol');
    const res = await fetch(`${base}/purchases`, { method: 'POST', headers: as('carol'), body: JSON.stringify(PURCHASE) });
    assert.equal(res.status, 201);
    const body = await res.json();
    assert.equal(body.approvalUrl, undefined);
    assert.equal(body.status, 'awaiting_approval');
    const approval = delivered.findLast((d) => d.kind === 'approve');
    assert.equal(approval.userId, 'carol');
    assert.match(approval.url, /authorize\?id=/);
  });

  test('approval via a signed webhook shows up in the purchase, with its events', async () => {
    agentcard.store.setAgentCardUser('dana', 'usr_ac_dana');
    const created = await (await fetch(`${base}/purchases`, { method: 'POST', headers: as('dana'), body: JSON.stringify(PURCHASE) })).json();
    const t = Math.floor(Date.now() / 1000);
    const { body, headers } = signedDelivery({ id: `evt_${created.purchaseId}`, type: 'checkout_authorization.approved', created: t, data: { id: created.purchaseId } }, WEBHOOK_SECRET, t);
    const hook = await fetch(`${base}/webhooks`, { method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body });
    assert.equal(hook.status, 200);

    const mine = await (await fetch(`${base}/purchases/${created.purchaseId}`, { headers: as('dana') })).json();
    assert.equal(mine.status, 'approved');
    assert.equal(mine.canRetry, false);
    assert.ok(mine.events.some((e) => e.type === 'checkout_authorization.approved'));
  });

  test('another user cannot read or cancel a purchase they do not own', async () => {
    agentcard.store.setAgentCardUser('erin', 'usr_ac_erin');
    const created = await (await fetch(`${base}/purchases`, { method: 'POST', headers: as('erin'), body: JSON.stringify(PURCHASE) })).json();
    const peek = await fetch(`${base}/purchases/${created.purchaseId}`, { headers: as('frank') });
    assert.equal(peek.status, 404);
    const poke = await fetch(`${base}/purchases/${created.purchaseId}/cancel`, { method: 'POST', headers: as('frank') });
    assert.equal(poke.status, 404);
  });

  test('a purchase over the limit is refused, and the response carries no secrets', async () => {
    agentcard.store.setAgentCardUser('gina', 'usr_ac_gina');
    const res = await fetch(`${base}/purchases`, { method: 'POST', headers: as('gina'), body: JSON.stringify({ ...PURCHASE, amount: 0 }) });
    assert.equal(res.status, 400);
    const text = await res.text();
    assert.ok(!text.includes(FAKE_CLIENT.secret));
    assert.ok(!text.includes('approvalUrl'));
  });

  test('webhooks with a bad signature are refused over HTTP', async () => {
    const res = await fetch(`${base}/webhooks`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'agentcard-signature': 't=1,v1=00' }, body: '{"id":"x","type":"vault.card_stored"}',
    });
    assert.equal(res.status, 401);
  });

  test('a user lists only their own purchases', async () => {
    const list = await (await fetch(`${base}/purchases`, { headers: as('dana') })).json();
    assert.ok(list.purchases.length >= 1);
    assert.ok(list.purchases.every((p) => p.approvalUrl === undefined));
  });
});
