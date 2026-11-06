/**
 * Card enrolment: a user saves their own card once, on AgentCard's page.
 *
 * Flow (AgentCard "Adding a card to the Vault"):
 *   1. Create a vault session (a returning user passes externalUserId, so
 *      they unlock with their passkey instead of re-entering the card).
 *   2. Deliver the session URL to the user, unchanged, through our channel.
 *   3. Learn the AgentCard user id from the vault.session_linked webhook, or
 *      by polling the session every poll_interval seconds.
 *
 * Before sending a link we check for a stored card, so a returning user is not
 * enrolled twice. We never read or rebuild the URL; it is passed to deliverLink.
 */

export const POLL_READ_BUDGET_PER_MINUTE = 40;

/**
 * @param {{
 *   api: ReturnType<import('./api.js').createAgentCardApi>,
 *   store: ReturnType<import('./store.js').createMemoryStore>,
 *   deliverLink: (userId: string, url: string, info: { sessionId: string, expiresAt: string }) => Promise<void> | void,
 *   now?: () => number,
 * }} deps
 */
export function createEnrolment({ api, store, deliverLink, now = () => Date.now() }) {
  /** Card list shape is not fully documented; accept the common envelopes. */
  function cardsFrom(body) {
    if (Array.isArray(body)) return body;
    if (Array.isArray(body?.data)) return body.data;
    if (Array.isArray(body?.cards)) return body.cards;
    return [];
  }

  function complete(sessionId, agentcardUserId) {
    const enrolment = store.getEnrolment(sessionId);
    if (!enrolment) return null; // not one of ours, or already forgotten
    store.setAgentCardUser(enrolment.userId, agentcardUserId);
    return store.updateEnrolment(sessionId, { status: 'linked', agentcardUserId });
  }

  return {
    /**
     * @param {string} userId our user id
     * @param {{ replaceCard?: boolean }} [opts] replaceCard adds a card even if one is stored
     * @returns {Promise<{ status: 'already_enrolled' | 'link_sent', cardCount?: number, sessionId?: string, expiresAt?: string }>}
     */
    async start(userId, { replaceCard = false } = {}) {
      if (!userId) throw new Error('enrolment.start needs a userId');
      const agentcardUserId = store.getAgentCardUser(userId);

      if (agentcardUserId && !replaceCard) {
        const cards = cardsFrom(await api.listVaultCards(agentcardUserId));
        if (cards.length > 0) return { status: 'already_enrolled', cardCount: cards.length };
      }

      // A user we already know gets a connected session for their own vault.
      // A new user gets an open session tagged with our id, so a returning user
      // on another device unlocks with a passkey instead of re-entering a card.
      const session = await api.createVaultSession(
        agentcardUserId ? { userId: agentcardUserId, steps: ['card'] } : { externalUserId: userId },
      );

      store.putEnrolment(session.id, {
        userId,
        status: 'pending',
        expiresAt: session.expires_at ?? null,
        pollIntervalSeconds: Number(session.poll_interval) || 3,
      });

      await deliverLink(userId, session.url, { sessionId: session.id, expiresAt: session.expires_at });
      return { status: 'link_sent', sessionId: session.id, expiresAt: session.expires_at ?? null };
    },

    /**
     * Poll one session once. Returns the status and records the user id on success.
     * Callers must respect poll_interval and POLL_READ_BUDGET_PER_MINUTE.
     */
    async poll(sessionId) {
      const enrolment = store.getEnrolment(sessionId);
      if (!enrolment) throw new Error('Unknown enrolment session');
      if (enrolment.status === 'linked') return { status: 'linked' };

      const session = await api.getVaultSession(sessionId);
      if (session.status === 'linked' && session.user_id) {
        complete(sessionId, session.user_id);
        return { status: 'linked' };
      }
      if (session.status === 'expired') {
        store.updateEnrolment(sessionId, { status: 'expired' });
        return { status: 'expired' };
      }
      return { status: 'pending', pollIntervalSeconds: enrolment.pollIntervalSeconds };
    },

    /** Called by the webhook handler for vault.session_linked, and by poll(). */
    complete,

    /** Called for vault.card_stored: a card is now on file. Nothing is kept beyond the event. */
    recordCardStored(agentcardUserId, card) {
      return { agentcardUserId, brand: card?.brand ?? null, last4: card?.last4 ?? null, at: now() };
    },
  };
}
