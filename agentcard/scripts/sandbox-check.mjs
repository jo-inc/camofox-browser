#!/usr/bin/env node
/**
 * Live check against AgentCard. Run it with SANDBOX credentials first.
 *
 *   node agentcard/scripts/sandbox-check.mjs                       # core checks
 *   node agentcard/scripts/sandbox-check.mjs --user usr_...        # + purchase path for a linked user
 *   node agentcard/scripts/sandbox-check.mjs --register-url https://your.app/agentcard/webhooks
 *
 * Reads AGENTCARD_CLIENT_ID, AGENTCARD_CLIENT_SECRET (and AGENTCARD_BASE_URL)
 * from the environment or the repo's .env. Values are never printed.
 *
 * Checks, in order:
 *   1. configuration is present
 *   2. client-credentials token exchange works, and the token is cached on reuse
 *   3. an enrolment session opens (test_mode must be true for sandbox)
 *   4. the session polls as pending
 *   5. an invalid session id is rejected with 404 (error handling is real)
 *   6. with --user: create an approval-gated authorization for a $0.01 test
 *      purchase, read its status, cancel it, and confirm it is no longer waiting
 *   7. with --register-url: register our webhook endpoint and store its secret
 *      in .env as AGENTCARD_WEBHOOK_SECRET (the secret is shown only once)
 *
 * Exit code is 0 only when every check that ran passed.
 */
import { existsSync, readFileSync, writeFileSync, appendFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { loadEnvFile } from 'node:process';
import { createAgentCardApi, AgentCardError, DEFAULT_BASE_URL } from '../src/index.js';

const ENV_PATH = resolve(process.cwd(), '.env');
if (existsSync(ENV_PATH)) loadEnvFile(ENV_PATH);

const args = process.argv.slice(2);
const flag = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] ?? true : null;
};
const userId = flag('--user');
const registerUrl = flag('--register-url');

let failures = 0;
const results = [];
function check(name, ok, detail = '') {
  if (!ok) failures += 1;
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
}
function stop(name, err) {
  const cause = err.cause?.code ? ` [${err.cause.code}]` : '';
  const detail = err instanceof AgentCardError
    ? `HTTP ${err.status}${err.code ? ` ${err.code}` : ''}: ${err.message}`
    : `${err.message}${cause}`;
  check(name, false, detail);
}

// 1. configuration
const clientId = process.env.AGENTCARD_CLIENT_ID?.trim();
const clientSecret = process.env.AGENTCARD_CLIENT_SECRET?.trim();
const baseUrl = (process.env.AGENTCARD_BASE_URL || DEFAULT_BASE_URL).trim();
check('configuration present (AGENTCARD_CLIENT_ID, AGENTCARD_CLIENT_SECRET)', Boolean(clientId && clientSecret));
if (!clientId || !clientSecret) {
  console.log('Add both values to the repo .env, or set them in the environment, then rerun.');
  process.exit(1);
}

const api = createAgentCardApi({ clientId, clientSecret, baseUrl });

async function main() {
  // 2. token exchange, then reuse. Counted by timing the second call, which must not re-exchange.
  let tokenFetches = 0;
  const countingFetch = globalThis.fetch;
  const spyApi = createAgentCardApi({
    clientId,
    clientSecret,
    baseUrl,
    fetchImpl: async (...a) => {
      if (String(a[0]).endsWith('/oauth/token')) tokenFetches += 1;
      return countingFetch(...a);
    },
  });
  // Probe with a lookup that needs no user: a made-up session id must return 404
  // (authenticated, not found), never 401 (bad token). Two probes, one token exchange.
  const probe = async () => {
    try {
      await spyApi.getVaultSession('vs_token_probe_0000');
      return 'unexpected-success';
    } catch (err) {
      return err instanceof AgentCardError ? err.status : `error:${err.message}`;
    }
  };
  const first = await probe();
  const second = await probe();
  const authenticated = first === 404 && second === 404;
  check(
    'token exchange works and is reused',
    authenticated && tokenFetches === 1,
    authenticated ? `token requests: ${tokenFetches}` : `probe statuses: ${first}, ${second}`,
  );
  if (!authenticated) return;

  // 3. open an enrolment session
  let session;
  try {
    session = await api.createVaultSession({ externalUserId: `sandbox-check-${randomUUID()}`, expiresIn: 900 });
    check('enrolment session opens', Boolean(session.id && session.url));
    check('session is sandbox (test_mode true)', session.test_mode === true, `test_mode=${session.test_mode}`);
    console.log(`      enrolment URL (open it yourself; connect code 111111): ${session.url}`);
  } catch (err) {
    stop('enrolment session opens', err);
    return;
  }

  // 4. poll
  try {
    const status = await api.getVaultSession(session.id);
    check('session polls as pending', status.status === 'pending', `status=${status.status}`);
  } catch (err) {
    stop('session polls as pending', err);
  }

  // 5. error handling against the live API
  try {
    await api.getVaultSession('vs_does_not_exist_000');
    check('unknown session is rejected with an error', false, 'request succeeded unexpectedly');
  } catch (err) {
    check('unknown session is rejected with an error', err instanceof AgentCardError && err.status === 404, `HTTP ${err.status}`);
  }

  // 6. purchase path (needs a user who has linked a sandbox card)
  if (userId && userId !== true) {
    try {
      const auth = await api.createAuthorization({
        user: userId,
        merchant: 'Sandbox check (cancel me)',
        amount: 1,
        currency: 'usd',
        psp: 'stripe',
        checkout_origin: 'https://example.com',
        request: { url: 'https://api.stripe.com/v1/tokens', method: 'POST', headers: {}, body: 'sandbox=check' },
      });
      check('authorization is created and awaits approval', auth.status === 'awaiting_approval', `status=${auth.status}`);
      check('authorization carries an approval link', typeof auth.approvalUrl === 'string' && auth.approvalUrl.startsWith('https://'));

      const read = await api.getAuthorization(auth.id);
      check('authorization reads back with the same id', read.id === auth.id, `status=${read.status}`);

      const cancelled = await api.cancelAuthorization(auth.id);
      check('authorization cancels while awaiting approval', cancelled.cancelled === true || cancelled.status === 'declined', `status=${cancelled.status}`);
    } catch (err) {
      stop('purchase path (authorization create, read, cancel)', err);
    }
  } else {
    console.log('SKIP  purchase path (pass --user <AgentCard user id> after linking a sandbox card)');
  }

  // 7. webhook endpoint
  if (registerUrl && registerUrl !== true) {
    try {
      const endpoint = await api.createWebhookEndpoint({
        url: registerUrl,
        enabledEvents: ['vault.session_linked', 'vault.card_stored', 'checkout_authorization.*'],
        description: 'Camofox sandbox check',
      });
      check('webhook endpoint registered', endpoint.status === 'active' && Boolean(endpoint.secret), `id=${endpoint.id}`);
      writeSecret('AGENTCARD_WEBHOOK_SECRET', endpoint.secret);
      console.log('      secret written to .env as AGENTCARD_WEBHOOK_SECRET (not printed)');
    } catch (err) {
      stop('webhook endpoint registered', err);
    }
  } else {
    console.log('SKIP  webhook endpoint (pass --register-url https://... to register one)');
  }
}

/** Write or replace one key in .env, keeping the file private. */
function writeSecret(key, value) {
  const lines = existsSync(ENV_PATH) ? readFileSync(ENV_PATH, 'utf8').split('\n').filter((l) => !l.startsWith(`${key}=`)) : [];
  const next = [...lines.filter((l) => l.length), `${key}=${value}`].join('\n') + '\n';
  writeFileSync(ENV_PATH, next, { mode: 0o600 });
}

await main();

const passed = results.filter((r) => r.ok).length;
console.log(`\n${passed}/${results.length} checks passed${failures ? `, ${failures} failed` : ''}`);
process.exit(failures ? 1 : 0);
