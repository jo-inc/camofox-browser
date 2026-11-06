# AgentCard integration

Payments for agents running on Camofox. Each user gets a browser and a payment
system together (plan sections 0 and 5). The user saves their own card once, on
AgentCard's page. The agent works through checkout and reaches the payment step.
Each purchase needs the user's approval on their own device. The agent never sees
the card number.

**Status:** the core is built and tested offline (43 tests, including real HTTP).
It has not run against live AgentCard yet. Mounting the routes in Camofox is a
separate, reviewed step (see "Mounting" below).

## What is built

| Module | What it does |
|---|---|
| `src/api.js` | REST client: token caching (one exchange, shared, refreshed before expiry), retries on 429 and 5xx, `slow_down` handling, errors without secrets |
| `src/enrolment.js` | Card enrolment: open session for a new user, connected session for a known user, check for a stored card first, poll (within the 40 reads/min budget), record the AgentCard user id |
| `src/purchases.js` | Approval-gated purchases: request (validated, optional limit), approval link delivered to the user only, cancel, refresh, webhook state machine, and a retry rule that never re-charges |
| `src/webhooks.js` | Signed webhook receiver: signature on the raw body, replay window, de-duplication by event id, release on failure so AgentCard retries, Node http adapter |
| `src/store.js` | Storage contract with an in-memory implementation (Redis replaces it later, plan section 8). Holds no card data |
| `src/routes.js` | Express routes under `/agentcard`. The user comes from the caller's session, never the request body |
| `src/vault.js` | Browser checkout through `@agent-cards/checkout` (`attachToPlaywright`) for Camofox pages |
| `src/service.js` | Composes all of the above. Registers the webhook endpoint with the events it uses |
| `src/config.js` | Credentials from environment variables only. Sandbox or production is set by the credential |

## Layout

```
agentcard/
  src/        modules above
  test/
    agentcard.test.js   unit and flow tests (node:test)
    routes.test.js      HTTP tests against the Express router
    fake-agentcard.js   in-process AgentCard double built from the documented contract
  scripts/
    sandbox-check.mjs   first live check (needs sandbox credentials)
```

## Run the tests

```
node --test agentcard/test/agentcard.test.js agentcard/test/routes.test.js
```

No network, no credentials and no SDK are needed. The fake implements the
endpoints and statuses in the AgentCard API reference, and enforces bearer auth.

## Configuration

| Variable | Required | Purpose |
|---|---|---|
| `AGENTCARD_CLIENT_ID` | yes | Platform client id |
| `AGENTCARD_CLIENT_SECRET` | yes | Platform client secret |
| `AGENTCARD_WEBHOOK_SECRET` | for webhooks | Endpoint signing secret (`whsec_...`), shown once when the endpoint is created |
| `AGENTCARD_BASE_URL` | no | Defaults to `https://api.agentcard.sh` |

Start with sandbox credentials. In sandbox, the connect code is `111111`, and
Stripe's published test cards work.

Keep secrets in the environment or a secret store. Never commit them or print
them.

## Live check (sandbox only)

The keys are read from the repo's `.env` (git-ignored), or from the environment.
Values are never printed.

```
node agentcard/scripts/sandbox-check.mjs                          # token, enrolment session, poll, error handling
node agentcard/scripts/sandbox-check.mjs --user usr_...           # + approval-gated purchase: create, read, cancel
node agentcard/scripts/sandbox-check.mjs --register-url https://your.app/agentcard/webhooks   # + webhook endpoint
```

- Core checks open a sandbox enrolment session and print its URL. Open it yourself
  and use connect code `111111` and Stripe's test card.
- `--user` needs an AgentCard user id that has a sandbox card on file.
- `--register-url` writes the endpoint secret to `.env` as `AGENTCARD_WEBHOOK_SECRET`.
  The secret is shown only once, so it is never printed.
- The script exits non-zero if any check that ran fails.

## Mounting (after review)

`server.js` is production code, so this is a separate step. Mount behind an
environment flag, so nothing changes unless it is set:

```js
if (process.env.AGENTCARD_ENABLED === '1') {
  const { createAgentCard, createAgentCardRouter, loadConfig, createMemoryStore } = await import('./agentcard/src/index.js');
  const agentcard = createAgentCard({ config: loadConfig(), store: createMemoryStore(), deliverLink, deliverApprovalLink });
  app.use('/agentcard', createAgentCardRouter({ agentcard, express, resolveUser: (req) => req.userIdFromSession }));
}
```

Open points before mounting:
- `resolveUser` must come from the authenticated session. Do not use the request body.
- The webhook route must run before the global JSON parser, or the raw body is lost.
- `deliverLink` and `deliverApprovalLink` must send the URL to the user through their own channel.
- The store is in memory. Use it only for a single instance until Redis is built.

## Rules this module follows (AgentCard docs)

- The API is called from the backend only.
- Card numbers never go through the chat or the model. Enrolment uses a link, and
  links are sent unchanged.
- Check for a stored card before sending a link, so a returning user is not enrolled twice.
- One AgentCard user id per end user. Never share one across users.
- Verify webhook signatures on the raw body. Reject timestamps older than 5 minutes.
- Act on webhook events, not on what the agent says.
- Approved and submitted purchases are never retried. A failed purchase is retried
  only when the merchant or the processor confirms it failed.
- Use `checkout_authorization.approved` as the authority for a charge, and
  `settled` only as confirmation the processor took the money.

## Assumptions to confirm in sandbox

These are not fully documented, so the code handles them defensively and the live
check must confirm them:

- The vault card list envelope. The code accepts an array, `data`, or `cards`.
- The webhook `data` object for checkout events. The code expects `data.id` to be
  the authorization id, and `data.settlement` when present.
- The `vault.card_stored` payload fields (`user_id`, `card_id`, `brand`, `last4`).
- Exact checkout event names beyond those listed in the webhook docs.

## Not built yet

- Commerce SDK for food, flights and tables (`@agent-cards/commerce-sdk`). The docs
  list DoorDash and other stores; each needs a connection flow.
- Issuing (new virtual cards). Not needed while we use the user's own card (plan Q1).
- Identity verification, company wallet, rewards and presets.
- Shared storage (Redis).
- Browser checkout has not been tested on Camofox (plan Q4).
- Fee display and refunds (plan Q2 and Q3).
