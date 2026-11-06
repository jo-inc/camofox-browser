# AgentCard integration

Payments for agents running on Camofox. Each user gets a browser and a
payment system together (plan section 0 and 5). The user saves their own card
once on AgentCard's page. The agent fills a placeholder card. The user approves
each payment on their own device. The agent never sees the card number.

Status: **first version.** Config, webhook verification, a purchase ledger and
checkout attachment are built and unit-tested. Live checkout is not yet tested
against Camofox (plan Q4). See "Open items" below.

## Layout

```
agentcard/
  src/
    config.js    credentials from environment variables only
    webhook.js   verify AgentCard-Signature (HMAC-SHA256, replay window)
    ledger.js    purchase outcomes per user, built from verified webhooks
    vault.js     VaultClient setup and attachment to Playwright pages
    index.js     public exports
  test/
    agentcard.test.js   node --test, no extra dependencies
```

## Configuration

| Variable | Required | Purpose |
|---|---|---|
| `AGENTCARD_CLIENT_ID` | yes | Platform client id |
| `AGENTCARD_CLIENT_SECRET` | yes | Platform client secret |
| `AGENTCARD_WEBHOOK_SECRET` | for webhooks | Endpoint signing secret (`whsec_...`) |

Start with sandbox credentials. Sandbox or production is set by the credential,
not by a URL or flag (AgentCard docs). In sandbox the connect code is always
`111111`.

Keep these in the environment or a secret store. Never commit them, and never
print them. `describeConfig()` reports only whether each value is set.

## Rules this module follows (AgentCard docs)

- The API is called from the backend only.
- Card numbers never go through the chat or the model. Cards are added through a
  Vault link, and links are passed untouched (`sendLink`), never rebuilt.
- Check for a stored card before sending a Vault link, so a returning user is
  not enrolled twice.
- One AgentCard user id per end user. Never share one id across users.
- Verify webhook signatures against the raw body, and reject timestamps older
  than 5 minutes.
- Act on webhook events, not on what the agent says. The ledger records events.
- The platform access token lasts one hour, with no refresh token. Cache it and
  exchange again at `/api/v2/oauth/token` (limited to 30 requests per 5 minutes
  per IP). The SDK handles this; do not add a second cache.

## Checkout flow

1. `createVault(config)` once per process. It syncs the processor list.
2. The agent reaches checkout in a Camofox page. The page is attached with
   `attachCheckout(client, page, { agentcardUserId, merchant, amountCents,
   onApprovalUrl })`. Use a context with `serviceWorkers: 'block'`.
3. `onApprovalUrl` delivers the approval link to the user over our channel.
4. The user approves with their passkey. AgentCard swaps in the real card and
   the merchant charges the user's own card.
5. The webhook handler verifies the signature, then calls `ledger.record(userId,
   event)` for `checkout_authorization.*`, `vault.*` and `transaction.*`.

Retail, food, tables and flights can use AgentCard's Commerce SDK instead
(`@agent-cards/commerce-sdk`). Those need no browser.

## Open items

- **Q4:** Does `@agent-cards/checkout` attach to Camofox, which is
  Firefox-based? The SDK's examples use Chromium over CDP. Test before relying
  on it. The fallback is a Chromium browser that AgentCard supports.
- **Merchant mapping:** `merchant` is shown to the user on the approval screen.
  Decide what goes there per site.
- **Ledger storage:** in memory for now. Move to shared storage with the Redis
  standby (plan Q5, section 8).
- **Webhook endpoint:** the HTTP route that receives deliveries is not built yet.
  It must use the raw request body.
- **Fee display and refunds:** plan Q2 and Q3.
- **Not yet built:** the Vault link route, the Commerce SDK integration.

## Install and test

```
npm install @agent-cards/checkout playwright-core   # only needed for live checkout
node --test agentcard/test/*.test.js
```

The unit tests need no network, no credentials and no SDK installed.
