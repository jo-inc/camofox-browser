/**
 * AgentCard configuration, read from environment variables only.
 *
 * Sandbox or production is chosen by the credential, never by a URL or a flag
 * (AgentCard docs). Start with sandbox credentials.
 *
 * Secret values are never logged, returned in errors, or included in
 * `describeConfig()`.
 */

const REQUIRED = ['AGENTCARD_CLIENT_ID', 'AGENTCARD_CLIENT_SECRET'];

/**
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {{ clientId: string, clientSecret: string, webhookSecret: string | null }}
 */
export function loadConfig(env = process.env) {
  const missing = REQUIRED.filter((name) => !env[name]);
  if (missing.length) {
    throw new Error(`AgentCard is not configured. Missing: ${missing.join(', ')}`);
  }
  return {
    clientId: env.AGENTCARD_CLIENT_ID,
    clientSecret: env.AGENTCARD_CLIENT_SECRET,
    webhookSecret: env.AGENTCARD_WEBHOOK_SECRET || null,
  };
}

/**
 * Safe-to-log summary: which values are present, never the values themselves.
 * @param {ReturnType<typeof loadConfig>} config
 */
export function describeConfig(config) {
  return {
    clientId: config.clientId ? 'set' : 'missing',
    clientSecret: config.clientSecret ? 'set' : 'missing',
    webhookSecret: config.webhookSecret ? 'set' : 'missing',
  };
}
