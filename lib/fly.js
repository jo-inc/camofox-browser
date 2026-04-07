/**
 * Fly.io horizontal scaling helpers.
 *
 * Tab IDs encode the owning machine: "{machineId}_{uuid}"
 * Requests for tabs on other machines get replayed via fly-replay header.
 *
 * When not running on Fly (no FLY_MACHINE_ID), all helpers are no-ops:
 * makeTabId() returns a plain UUID and isLocalTab() always returns true.
 */

import crypto from 'crypto';

export function createFlyHelpers(config) {
  const machineId = config.flyMachineId || '';

  function makeTabId() {
    const uuid = crypto.randomUUID();
    return machineId ? `${machineId}_${uuid}` : uuid;
  }

  function parseTabOwner(tabId) {
    if (!machineId || !tabId) return null;
    const idx = tabId.indexOf('_');
    if (idx === -1) return null; // legacy tab ID (no machine prefix)
    const candidate = tabId.slice(0, idx);
    // Fly machine IDs are hex strings (14 chars). UUIDs start with 8 hex chars then '-'.
    // If the candidate contains '-', it's a UUID segment, not a machine ID.
    if (candidate.includes('-')) return null;
    return candidate;
  }

  function isLocalTab(tabId) {
    const owner = parseTabOwner(tabId);
    return owner === null || owner === machineId;
  }

  /**
   * Express middleware: replay requests for tabs owned by other machines.
   * No-op when not running on Fly.
   */
  function replayMiddleware(log) {
    return (req, res, next) => {
      if (!machineId) return next();
      const tabId = req.params.tabId;
      if (!tabId || isLocalTab(tabId)) return next();
      const owner = parseTabOwner(tabId);
      log('info', 'fly-replay', { reqId: req.reqId, tabId, owner, self: machineId });
      res.set('fly-replay', `instance=${owner}`);
      res.status(307).send();
    };
  }

  return { machineId, makeTabId, parseTabOwner, isLocalTab, replayMiddleware };
}
