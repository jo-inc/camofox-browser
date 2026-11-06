#!/usr/bin/env node
/**
 * First live check against AgentCard SANDBOX credentials.
 *
 *   AGENTCARD_CLIENT_ID=... AGENTCARD_CLIENT_SECRET=... node agentcard/scripts/sandbox-check.mjs
 *
 * Steps:
 *   1. Exchange client credentials for an access token.
 *   2. Create an open vault session (the card-enrolment link for a new user).
 *   3. Poll it once and print its status.
 *
 * The enrolment URL is printed so you can open it yourself. Use Stripe's test
 * card and the sandbox connect code 111111. Nothing secret is printed.
 */
import { loadConfig, describeConfig, createAgentCardApi, DEFAULT_BASE_URL } from '../src/index.js';

const config = loadConfig();
console.log('config:', describeConfig(config));

const api = createAgentCardApi({ clientId: config.clientId, clientSecret: config.clientSecret, baseUrl: process.env.AGENTCARD_BASE_URL || DEFAULT_BASE_URL });

const session = await api.createVaultSession({ externalUserId: `sandbox-check-${Date.now()}`, expiresIn: 900 });
console.log('vault session:', { id: session.id, test_mode: session.test_mode, poll_interval: session.poll_interval, expires_at: session.expires_at });
console.log('enrolment url (open in a browser, sandbox code 111111):');
console.log(session.url);

const status = await api.getVaultSession(session.id);
console.log('status:', status.status);

if (session.test_mode !== true) {
  console.warn('WARNING: test_mode is not true. Check that these are sandbox credentials before going further.');
}
