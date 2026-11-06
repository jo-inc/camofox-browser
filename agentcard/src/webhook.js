/**
 * Verify AgentCard webhook deliveries.
 *
 * The `AgentCard-Signature` header has the form `t=<unix seconds>,v1=<hex>`.
 * The signature is HMAC-SHA256 over `${t}.${rawBody}` using the endpoint
 * secret. It must be checked against the raw request bytes, never against
 * re-serialised JSON, and timestamps outside the tolerance are rejected to
 * block replays.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';

export const DEFAULT_TOLERANCE_SECONDS = 300;

/**
 * @param {{
 *   header: string | undefined,
 *   rawBody: string | Buffer,
 *   secret: string,
 *   now?: number,            // unix seconds, injectable for tests
 *   toleranceSeconds?: number,
 * }} input
 * @returns {boolean}
 */
export function verifyWebhookSignature({
  header,
  rawBody,
  secret,
  now = Math.floor(Date.now() / 1000),
  toleranceSeconds = DEFAULT_TOLERANCE_SECONDS,
}) {
  if (!header || !secret) return false;

  const parts = Object.fromEntries(
    header.split(',').map((pair) => {
      const i = pair.indexOf('=');
      return i < 0 ? [pair.trim(), ''] : [pair.slice(0, i).trim(), pair.slice(i + 1).trim()];
    }),
  );
  const t = Number(parts.t);
  const v1 = parts.v1;
  if (!Number.isFinite(t) || !v1) return false;
  if (Math.abs(now - t) > toleranceSeconds) return false;

  const body = Buffer.isBuffer(rawBody) ? rawBody.toString('utf8') : String(rawBody);
  const expected = createHmac('sha256', secret).update(`${parts.t}.${body}`).digest('hex');

  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(v1, 'utf8');
  return a.length === b.length && timingSafeEqual(a, b);
}
