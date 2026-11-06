/**
 * Vault checkout for pages driven by Camofox.
 *
 * Flow (plan section 5): the agent fills a placeholder card. The SDK intercepts
 * the payment request, AgentCard sends the user an approval link, and the user
 * approves on their own device. The agent never sees the card number.
 *
 * The SDK is loaded lazily, so importing this module does not require
 * `@agent-cards/checkout` to be installed.
 *
 * Rules from the AgentCard docs that this module enforces:
 * - The API is called from the backend only. Credentials come from config.
 * - Every shopper has their own AgentCard user id (`externalUserId` mapping).
 * - The approval URL is passed to `onApprovalUrl` untouched. Callers must not
 *   edit or rebuild it, and it is never logged here.
 */

let sdkPromise = null;

/** Loads the SDK once per process. */
export function loadCheckoutSdk() {
  if (!sdkPromise) {
    sdkPromise = import('@agent-cards/checkout').catch((err) => {
      sdkPromise = null;
      throw new Error(
        `@agent-cards/checkout is not installed. Run: npm install @agent-cards/checkout playwright-core (${err.code ?? err.message})`,
      );
    });
  }
  return sdkPromise;
}

/**
 * Create a VaultClient and sync the processor list. Call once per process.
 * @param {{ clientId: string, clientSecret: string }} config
 * @param {{ loadSdk?: () => Promise<any> }} [deps] injectable for tests
 */
export async function createVault(config, deps = {}) {
  const sdk = await (deps.loadSdk ?? loadCheckoutSdk)();
  const vault = new sdk.VaultClient({ clientId: config.clientId, clientSecret: config.clientSecret });
  await vault.syncRegistry();
  return { vault, sdk };
}

/**
 * Attach checkout to a Playwright page before the agent reaches payment.
 *
 * @param {{ vault: any, sdk: any }} client from createVault
 * @param {object} page a Playwright page
 * @param {{
 *   agentcardUserId: string,       // the user's AgentCard user id (usr_...)
 *   merchant: string,              // shown to the user on the approval screen
 *   amountCents: number,
 *   currency?: string,
 *   onApprovalUrl: (url: string) => void,
 *   onStateChange?: (state: object) => void,
 *   onEvent?: (event: object) => void,
 *   timeoutMs?: number,
 * }} purchase
 */
export async function attachCheckout(client, page, purchase) {
  if (!purchase?.agentcardUserId) throw new Error('attachCheckout needs agentcardUserId');
  if (!purchase.merchant) throw new Error('attachCheckout needs merchant');
  if (!Number.isInteger(purchase.amountCents) || purchase.amountCents <= 0) {
    throw new Error('attachCheckout needs a positive integer amountCents');
  }
  if (typeof purchase.onApprovalUrl !== 'function') {
    throw new Error('attachCheckout needs onApprovalUrl');
  }

  return client.sdk.attachToPlaywright(page, {
    vault: client.vault,
    user: purchase.agentcardUserId,
    merchant: purchase.merchant,
    amount: purchase.amountCents,
    currency: purchase.currency ?? 'usd',
    timeoutMs: purchase.timeoutMs,
    onApprovalUrl: purchase.onApprovalUrl,
    onStateChange: purchase.onStateChange,
    onEvent: purchase.onEvent,
  });
}
