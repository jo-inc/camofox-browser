/**
 * ARIA snapshot annotation helpers.
 *
 * Shared by the /snapshot route and the /click semantic-target precondition
 * guard so both produce identical [eN] ref-annotated snapshot text. Kept in a
 * module (rather than inline in server.js) so the pure string logic is unit
 * testable without a live browser.
 */
import { INTERACTIVE_ROLES } from './interactive-roles.js';

// Accessible-name substrings whose rows should never be annotated with a ref
// (date pickers and calendars explode into hundreds of noise cells).
export const SKIP_PATTERNS = [
  /datepicker/i, /date.?picker/i, /calendar/i, /^date$/i,
];

export function normalizedAccessibleName(value) {
  return String(value || '').replace(/\s+/g, ' ').trim().toLocaleLowerCase();
}

/**
 * Annotate an ARIA snapshot YAML with [eN] ref markers on interactive rows.
 * @param {string} ariaYaml raw ariaSnapshot() YAML
 * @param {Map<string,{role:string,name:string,nth:number}>} refs
 * @returns {string} the YAML with [eN] appended to matched interactive rows
 */
export function annotateAriaSnapshotRefs(ariaYaml, refs) {
  if (!ariaYaml || !(refs instanceof Map) || refs.size === 0) return ariaYaml || '';
  const refsByKey = new Map();
  for (const [refId, info] of refs) {
    refsByKey.set(`${info.role}:${info.name}:${info.nth}`, refId);
  }
  const annotationCounts = new Map();
  return ariaYaml.split('\n').map(line => {
    const match = line.match(/^(\s*-\s+)(\w+)(\s+"([^"]*)")?(.*)$/);
    if (!match) return line;
    const [, prefix, role, nameMatch, name, suffix] = match;
    const normalizedRole = role.toLowerCase();
    if (name && SKIP_PATTERNS.some(p => p.test(name))) return line;
    if (!INTERACTIVE_ROLES.includes(normalizedRole)) return line;
    const normalizedName = name || '';
    const countKey = `${normalizedRole}:${normalizedName}`;
    const nth = annotationCounts.get(countKey) || 0;
    annotationCounts.set(countKey, nth + 1);
    const refId = refsByKey.get(`${normalizedRole}:${normalizedName}:${nth}`);
    return refId ? `${prefix}${role}${nameMatch || ''} [${refId}]${suffix}` : line;
  }).join('\n');
}
