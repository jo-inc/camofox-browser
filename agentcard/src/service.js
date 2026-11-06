/**
 * Composes the AgentCard integration: API client, store, enrolment, purchases,
 * webhooks, and browser checkout.
 *
 * Usage (backend only):
 *   const agentcard = createAgentCard({
 *     config: loadConfig(),
 *     store: createMemoryStore(),
 *     deliverLink: async (userId, url) => sendToUser(userId, url),
 *     deliverApprovalLink: async (userId, url, info) => sendToUser(userId, url),
 *   });
 */
import { createAgentCardApi } from './api.js';
import { createMemoryStore } from './store.js';
import { createEnrolment } from './enrolment.js';
import { createPurchases } from './purchases.js';
import { createWebhookHandler, createNodeRoute } from './webhooks.js';
import { createVault, attachCheckout } from './vault.js';

/** Events we subscribe to when registering our endpoint. */
export const SUBSCRIBED_EVENTS = [
  'vault.session_linked',
  'vault.card_stored',
  'checkout_authorization.*',
];

/**
 * @param {{
 *   config: { clientId: string, clientSecret: string, webhookSecret: string | null },
 *   store?: ReturnType<typeof createMemoryStore>,
 *   deliverLink: (userId: string, url: string, info: object) => Promise<void> | void,
 *   deliverApprovalLink: (userId: string, url: string, info: object) => Promise<void> | void,
 *   maxAmountCents?: number,
 *   fetchImpl?: typeof fetch,
 *   now?: () => number,
 *   sleep?: (ms: number) => Promise<void>,
 *   onEvent?: (event: object) => void,
 * }} options
 */
export function createAgentCard(options) {
  const { config } = options;
  const store = options.store ?? createMemoryStore();
  const api = createAgentCardApi({
    clientId: config.clientId,
    clientSecret: config.clientSecret,
    fetchImpl: options.fetchImpl,
    now: options.now,
    sleep: options.sleep,
  });
  const enrolment = createEnrolment({ api, store, deliverLink: options.deliverLink, now: options.now });
  const purchases = createPurchases({
    api,
    store,
    deliverApprovalLink: options.deliverApprovalLink,
    maxAmountCents: options.maxAmountCents ?? null,
  });

  let webhookHandler = null;
  let vaultClient = null;

  function getWebhooks() {
    if (!config.webhookSecret) throw new Error('AGENTCARD_WEBHOOK_SECRET is not set');
    if (!webhookHandler) {
      webhookHandler = createWebhookHandler({
        secret: config.webhookSecret,
        store,
        enrolment,
        purchases,
        onEvent: options.onEvent,
        now: options.now,
      });
    }
    return webhookHandler;
  }

  return {
    api,
    store,
    enrolment,
    purchases,

    /** Webhook handler. Needs AGENTCARD_WEBHOOK_SECRET. */
    webhooks: getWebhooks,

    /** Node http route for the webhook endpoint. */
    webhookRoute() {
      return createNodeRoute(getWebhooks());
    },

    /**
     * Register our endpoint with AgentCard. Run once per environment, then store
     * the returned secret in AGENTCARD_WEBHOOK_SECRET. The secret is shown only once.
     */
    registerWebhookEndpoint({ url, description }) {
      return api.createWebhookEndpoint({ url, enabledEvents: SUBSCRIBED_EVENTS, description });
    },

    /**
     * Attach checkout to a Playwright page through the SDK. The SDK pauses the
     * card request and calls onApprovalUrl. Purchase outcomes arrive by webhook.
     */
    async attachCheckout(page, purchase) {
      if (!vaultClient) vaultClient = await createVault(config, { loadSdk: options.loadSdk });
      const agentcardUserId = store.getAgentCardUser(purchase.userId);
      if (!agentcardUserId) {
        const err = new Error('This user has no card on file. Send an enrolment link first.');
        err.code = 'not_enrolled';
        throw err;
      }
      return attachCheckout(vaultClient, page, { ...purchase, agentcardUserId });
    },
  };
}
