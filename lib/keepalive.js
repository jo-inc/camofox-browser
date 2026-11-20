// userIds the idle reapers spare. A person signing in over VNC makes no API call, so the tab and session reapers
// would close the tab under them. Standing userIds (CAMOFOX_KEEPALIVE_USERS) are always kept; PUT
// /sessions/:userId/keepalive keeps one more until a deadline, and DELETE ends that early.

export const KEEPALIVE_DEFAULT_MINUTES = 120;
export const KEEPALIVE_MAX_MINUTES = 1440;

export function parseKeepaliveUsers(value) {
  return String(value || '').split(',').map((s) => s.trim()).filter(Boolean);
}

export function validKeepaliveMinutes(minutes) {
  return typeof minutes === 'number' && minutes > 0 && minutes <= KEEPALIVE_MAX_MINUTES;
}

export function createKeepAlive(standingUsers = []) {
  const standing = new Set(standingUsers);
  const until = new Map();
  return {
    isStanding: (userId) => standing.has(userId),
    isKeptAlive(userId, now = Date.now()) {
      if (standing.has(userId)) return true;
      const deadline = until.get(userId);
      if (deadline === undefined) return false;
      if (deadline <= now) {
        until.delete(userId);
        return false;
      }
      return true;
    },
    keep(userId, minutes, now = Date.now()) {
      const deadline = now + minutes * 60_000;
      until.set(userId, deadline);
      return deadline;
    },
    end: (userId) => until.delete(userId),
  };
}
