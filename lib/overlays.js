/**
 * Overlay dismissal target selection.
 *
 * Pure functions. They decide which element refs are safe to click to close a
 * pop-up, modal or banner. Only exact, known "close" labels on buttons are
 * accepted. Anything that could accept terms, sign in, buy, submit or continue
 * is never selected, even if it appears in the same overlay.
 */

// Exact (normalized) button names that only close or decline an overlay.
const DISMISS_NAMES = new Set([
  'close',
  'close dialog',
  'close modal',
  'close popup',
  'close pop-up',
  'close window',
  'dismiss',
  'no thanks',
  'no, thanks',
  'not now',
  'maybe later',
  'remind me later',
  'skip',
  'skip for now',
  'x',
  '×',
  '✕',
  '✖',
]);

// Defence in depth: a name containing any of these is never clicked, even if
// it somehow matched the allow-list above.
const DENY_PATTERN =
  /\b(accept|allow|agree|sign|log ?in|buy|cart|checkout|pay|subscribe|submit|continue|confirm|download|install|share|delete|order|book|apply|register|join|upgrade|claim|yes|next|send|save)\b/i;

export function normalizeOverlayName(name) {
  return String(name || '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

/**
 * @param {string} name accessible name of a candidate element
 * @returns {boolean} true when the element is a safe dismiss control
 */
export function isDismissName(name) {
  const normalized = normalizeOverlayName(name);
  if (!normalized) return false;
  if (DENY_PATTERN.test(normalized)) return false;
  return DISMISS_NAMES.has(normalized);
}

/**
 * Convert a tab's ref map (refId -> {role, name, ...}) into candidate records.
 *
 * @param {Map<string, {role: string, name?: string}>} refs
 * @returns {Array<{ref: string, role: string, name: string}>}
 */
export function refsToCandidates(refs) {
  if (!refs || typeof refs.entries !== 'function') return [];
  const out = [];
  for (const [ref, info] of refs.entries()) {
    out.push({ ref, role: info?.role || '', name: info?.name || '' });
  }
  return out;
}

/**
 * Choose which candidates to click.
 *
 * @param {Array<{ref: string, role: string, name: string}>} candidates
 * @param {{limit?: number}} [options]
 * @returns {Array<{ref: string, role: string, name: string}>}
 */
export function selectOverlayTargets(candidates, { limit = 3 } = {}) {
  const max = Math.min(Math.max(Number(limit) || 1, 1), 5);
  const picked = [];
  for (const candidate of candidates || []) {
    if (!candidate || candidate.role !== 'button') continue;
    if (!isDismissName(candidate.name)) continue;
    picked.push(candidate);
    if (picked.length >= max) break;
  }
  return picked;
}
