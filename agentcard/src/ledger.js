/**
 * Record of purchase outcomes, built from AgentCard webhooks.
 *
 * We act on webhook events, never on what the agent reports. Each verified
 * event is appended here so a purchase's status can be shown to the user and
 * audited.
 *
 * Card data is never stored. Only event type, object id and receipt time.
 *
 * This is an in-memory implementation for the first version. Shared storage
 * (Redis, see plan section 8) replaces it without changing this interface.
 */

const TRACKED_PREFIXES = ['checkout_authorization.', 'vault.', 'transaction.'];

/**
 * @typedef {{ type: string, objectId: string | null, receivedAt: string }} LedgerEntry
 */

export function createLedger({ now = () => new Date().toISOString() } = {}) {
  /** @type {Map<string, LedgerEntry[]>} keyed by our user id */
  const byUser = new Map();

  return {
    /**
     * @param {string} userId our user id, mapped from the AgentCard user id
     * @param {{ type: string, data?: { id?: string } }} event a verified webhook event
     */
    record(userId, event) {
      if (!userId) throw new Error('ledger.record needs a userId');
      if (!TRACKED_PREFIXES.some((p) => event.type?.startsWith(p))) return null;
      const entry = { type: event.type, objectId: event.data?.id ?? null, receivedAt: now() };
      const list = byUser.get(userId) ?? [];
      list.push(entry);
      byUser.set(userId, list);
      return entry;
    },

    /** @returns {LedgerEntry[]} */
    list(userId) {
      return [...(byUser.get(userId) ?? [])];
    },

    /** Remove everything held for a user (matches DELETE /sessions/:userId). */
    forget(userId) {
      return byUser.delete(userId);
    },
  };
}
