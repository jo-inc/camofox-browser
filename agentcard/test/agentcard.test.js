import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { verifyWebhookSignature, loadConfig, describeConfig, createLedger, attachCheckout } from '../src/index.js';

const SECRET = 'whsec_test_only';
const NOW = 1757264400;

function sign(body, t = NOW, secret = SECRET) {
  const v1 = createHmac('sha256', secret).update(`${t}.${body}`).digest('hex');
  return `t=${t},v1=${v1}`;
}

test('webhook: accepts a correctly signed delivery', () => {
  const body = '{"type":"vault.card_stored","data":{"card_id":"c_1"}}';
  assert.equal(verifyWebhookSignature({ header: sign(body), rawBody: body, secret: SECRET, now: NOW }), true);
});

test('webhook: accepts a Buffer body', () => {
  const body = '{"type":"vault.session_linked"}';
  assert.equal(
    verifyWebhookSignature({ header: sign(body), rawBody: Buffer.from(body), secret: SECRET, now: NOW }),
    true,
  );
});

test('webhook: rejects a tampered body', () => {
  const body = '{"amount":100}';
  const header = sign(body);
  assert.equal(verifyWebhookSignature({ header, rawBody: '{"amount":999}', secret: SECRET, now: NOW }), false);
});

test('webhook: rejects a wrong secret', () => {
  const body = '{}';
  assert.equal(verifyWebhookSignature({ header: sign(body, NOW, 'whsec_other'), rawBody: body, secret: SECRET, now: NOW }), false);
});

test('webhook: rejects a timestamp outside tolerance (replay)', () => {
  const body = '{}';
  const old = NOW - 301;
  assert.equal(verifyWebhookSignature({ header: sign(body, old), rawBody: body, secret: SECRET, now: NOW }), false);
  assert.equal(verifyWebhookSignature({ header: sign(body, NOW - 300), rawBody: body, secret: SECRET, now: NOW }), true);
});

test('webhook: rejects missing or malformed headers and secrets', () => {
  const body = '{}';
  assert.equal(verifyWebhookSignature({ header: undefined, rawBody: body, secret: SECRET, now: NOW }), false);
  assert.equal(verifyWebhookSignature({ header: 'garbage', rawBody: body, secret: SECRET, now: NOW }), false);
  assert.equal(verifyWebhookSignature({ header: sign(body), rawBody: body, secret: '', now: NOW }), false);
  assert.equal(verifyWebhookSignature({ header: `t=${NOW}`, rawBody: body, secret: SECRET, now: NOW }), false);
});

test('config: names missing variables without revealing values', () => {
  assert.throws(() => loadConfig({}), /AGENTCARD_CLIENT_ID, AGENTCARD_CLIENT_SECRET/);
  const config = loadConfig({ AGENTCARD_CLIENT_ID: 'id_abc', AGENTCARD_CLIENT_SECRET: 'sec_xyz' });
  const summary = JSON.stringify(describeConfig(config));
  assert.ok(!summary.includes('id_abc') && !summary.includes('sec_xyz'));
  assert.equal(config.webhookSecret, null);
});

test('ledger: records only checkout, vault and transaction events', () => {
  const ledger = createLedger({ now: () => '2026-11-06T09:00:00.000Z' });
  assert.equal(ledger.record('u1', { type: 'checkout_authorization.approved', data: { id: 'ca_1' } }).objectId, 'ca_1');
  assert.equal(ledger.record('u1', { type: 'customer.created', data: {} }), null);
  assert.equal(ledger.list('u1').length, 1);
  assert.deepEqual(ledger.list('nobody'), []);
});

test('ledger: needs a user id and can forget a user', () => {
  const ledger = createLedger();
  assert.throws(() => ledger.record('', { type: 'vault.card_stored' }), /userId/);
  ledger.record('u2', { type: 'vault.card_stored', data: { id: 'c_2' } });
  assert.equal(ledger.forget('u2'), true);
  assert.deepEqual(ledger.list('u2'), []);
});

test('checkout: refuses to attach without the required purchase fields', async () => {
  const client = { vault: {}, sdk: { attachToPlaywright: async () => 'attached' } };
  const ok = { agentcardUserId: 'usr_1', merchant: 'shop.example.com', amountCents: 2306, onApprovalUrl: () => {} };
  assert.equal(await attachCheckout(client, {}, ok), 'attached');
  await assert.rejects(attachCheckout(client, {}, { ...ok, agentcardUserId: '' }), /agentcardUserId/);
  await assert.rejects(attachCheckout(client, {}, { ...ok, merchant: '' }), /merchant/);
  await assert.rejects(attachCheckout(client, {}, { ...ok, amountCents: 0 }), /amountCents/);
  await assert.rejects(attachCheckout(client, {}, { ...ok, amountCents: 12.5 }), /amountCents/);
  await assert.rejects(attachCheckout(client, {}, { ...ok, onApprovalUrl: undefined }), /onApprovalUrl/);
});
