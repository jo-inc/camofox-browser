/**
 * Storage for AgentCard state: user mappings, enrolment sessions, purchases,
 * the purchase event log, and webhook de-duplication.
 *
 * Holds no card data. Card numbers never reach our servers; AgentCard holds
 * them, encrypted on the user's device.
 *
 * This file defines the contract and an in-memory implementation. The Redis
 * standby (plan section 8) provides another implementation of the same
 * methods, so callers do not change.
 */

/**
 * @typedef {object} PurchaseRecord
 * @property {string} id                 checkout authorization id (cauth_...)
 * @property {string} userId             our user id
 * @property {string} merchant
 * @property {number|null} amount        smallest currency unit
 * @property {string|null} currency
 * @property {string} status             awaiting_approval | approved | submitted | declined | expired | refused | settled | not_settled
 * @property {object|null} settlement
 * @property {string} createdAt
 * @property {string} updatedAt
 */

export function createMemoryStore({ now = () => new Date().toISOString(), seenLimit = 10_000 } = {}) {
  /** @type {Map<string, string>} our userId -> AgentCard user id */
  const userMap = new Map();
  /** @type {Map<string, object>} vault session id -> { userId, status } */
  const enrolments = new Map();
  /** @type {Map<string, PurchaseRecord>} */
  const purchases = new Map();
  /** @type {Map<string, Array<object>>} purchase id -> ordered events */
  const purchaseEvents = new Map();
  /** @type {Set<string>} webhook event ids already processed */
  const seenEvents = new Set();

  return {
    // --- user mapping ---
    getAgentCardUser(userId) {
      return userMap.get(userId) ?? null;
    },
    setAgentCardUser(userId, agentcardUserId) {
      userMap.set(userId, agentcardUserId);
    },

    // --- enrolment sessions ---
    putEnrolment(sessionId, record) {
      enrolments.set(sessionId, { ...record, updatedAt: now() });
    },
    getEnrolment(sessionId) {
      const found = enrolments.get(sessionId);
      return found ? { ...found } : null;
    },
    updateEnrolment(sessionId, patch) {
      const current = enrolments.get(sessionId);
      if (!current) return null;
      const next = { ...current, ...patch, updatedAt: now() };
      enrolments.set(sessionId, next);
      return { ...next };
    },

    // --- purchases ---
    putPurchase(record) {
      purchases.set(record.id, { ...record });
      return { ...record };
    },
    getPurchase(id) {
      const found = purchases.get(id);
      return found ? { ...found } : null;
    },
    updatePurchase(id, patch) {
      const current = purchases.get(id);
      if (!current) return null;
      const next = { ...current, ...patch, updatedAt: now() };
      purchases.set(id, next);
      return { ...next };
    },
    listPurchases(userId) {
      return [...purchases.values()].filter((p) => p.userId === userId).map((p) => ({ ...p }));
    },
    appendPurchaseEvent(purchaseId, event) {
      const list = purchaseEvents.get(purchaseId) ?? [];
      list.push({ ...event, at: now() });
      purchaseEvents.set(purchaseId, list);
    },
    listPurchaseEvents(purchaseId) {
      return [...(purchaseEvents.get(purchaseId) ?? [])];
    },

    // --- webhook de-duplication ---
    /** Returns true the first time an event id is seen, false afterwards. */
    markEventSeen(eventId) {
      if (seenEvents.has(eventId)) return false;
      seenEvents.add(eventId);
      if (seenEvents.size > seenLimit) {
        const oldest = seenEvents.values().next().value;
        seenEvents.delete(oldest);
      }
      return true;
    },

    /** Release an event id after a failed handler, so the retry is processed. */
    unmarkEvent(eventId) {
      seenEvents.delete(eventId);
    },

    /** Remove everything held for a user (matches DELETE /sessions/:userId). */
    forgetUser(userId) {
      userMap.delete(userId);
      for (const [id, s] of enrolments) if (s.userId === userId) enrolments.delete(id);
      for (const [id, p] of purchases) {
        if (p.userId === userId) {
          purchases.delete(id);
          purchaseEvents.delete(id);
        }
      }
    },
  };
}
