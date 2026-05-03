/**
 * Timezone polyfill template renderer for BugHunter V23.
 *
 * Generates a self-contained JS snippet that patches Date and Intl to behave
 * as if the browser is running in the given IANA timezone. The snippet is
 * designed to be passed to page.addInitScript() so it runs before any page
 * code on every new document.
 *
 * Design decisions:
 * - Offset table is computed server-side from Node's Intl at render time and
 *   embedded as a JS literal. Avoids shipping moment-timezone (~200 KB) into
 *   the page and avoids an async lookup at page runtime.
 * - DST is honoured: offset is computed per-timestamp, not a single fixed offset.
 *   We sample the zone at 24-hour intervals across the next 2 years and embed the
 *   transitions so the page-side code can binary-search for the right offset.
 * - Only the methods BugHunter V23 needs are patched:
 *     Date.prototype.getTimezoneOffset
 *     Date.prototype.toString / toLocaleString / toLocaleDateString / toLocaleTimeString
 *     Intl.DateTimeFormat (constructor wrapper defaulting timeZone)
 */

/**
 * Build a precise DST transition table for the given timezone over a 4-year window.
 * Returns an array of [unixMs, offsetMinutes] sorted ascending by unixMs.
 * The page-side binary search picks the last entry whose unixMs <= Date.now().
 *
 * Algorithm: coarse scan at 12-hour intervals to detect where the offset changes,
 * then bisect each detected change to minute precision. This gives a compact table
 * (~10-20 entries for zones with DST) without the O(4M) cost of 1-minute sampling.
 *
 * @param {string} tzId - IANA timezone identifier
 * @returns {Array<[number, number]>}
 */
function buildOffsetTable(tzId) {
  const now = Date.now();
  const twoYears = 2 * 365 * 24 * 60 * 60 * 1000;
  const start = now - twoYears;
  const end = now + twoYears;
  const coarseStep = 12 * 60 * 60 * 1000; // 12-hour coarse scan

  const transitions = []; // array of [exactMs, newOffset]

  let prevOffset = getUtcOffsetMinutes(tzId, start);
  for (let t = start + coarseStep; t <= end; t += coarseStep) {
    const offset = getUtcOffsetMinutes(tzId, t);
    if (offset !== prevOffset) {
      // Bisect to find the exact minute of the transition
      let lo = t - coarseStep;
      let hi = t;
      while (hi - lo > 1000) { // bisect to 1-second precision
        const mid = Math.floor((lo + hi) / 2);
        if (getUtcOffsetMinutes(tzId, mid) === prevOffset) lo = mid;
        else hi = mid;
      }
      transitions.push([hi, offset]);
      prevOffset = offset;
    }
  }

  // Build final table: always start with a sentinel for the beginning of the window
  const entries = [[start, getUtcOffsetMinutes(tzId, start)], ...transitions];
  return entries;
}

/**
 * Returns the UTC offset in minutes (negative west of UTC) for the given IANA
 * timezone at the given Unix timestamp.
 *
 * @param {string} tzId
 * @param {number} unixMs
 * @returns {number}
 */
function getUtcOffsetMinutes(tzId, unixMs) {
  try {
    const date = new Date(unixMs);
    // Format both in UTC and the target zone, then subtract.
    const utcParts = new Intl.DateTimeFormat('en-US', {
      timeZone: 'UTC',
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', hour12: false,
    }).formatToParts(date);

    const zoneParts = new Intl.DateTimeFormat('en-US', {
      timeZone: tzId,
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', hour12: false,
    }).formatToParts(date);

    const pick = (parts, type) => parseInt(parts.find((p) => p.type === type)?.value ?? '0', 10);

    const utcMs = Date.UTC(pick(utcParts, 'year'), pick(utcParts, 'month') - 1, pick(utcParts, 'day'), pick(utcParts, 'hour'), pick(utcParts, 'minute'));
    const zoneMs = Date.UTC(pick(zoneParts, 'year'), pick(zoneParts, 'month') - 1, pick(zoneParts, 'day'), pick(zoneParts, 'hour'), pick(zoneParts, 'minute'));

    // offset = zone - utc, in minutes. getTimezoneOffset returns utc - zone.
    return (zoneMs - utcMs) / 60000;
  } catch {
    return 0;
  }
}

/**
 * Render the timezone polyfill script for injection into the page.
 *
 * @param {string} tzId - IANA timezone identifier (e.g. 'America/New_York')
 * @returns {string} - JS source to pass to page.addInitScript()
 */
export function renderTimezonePolyfill(tzId) {
  const table = buildOffsetTable(tzId);
  const tableJson = JSON.stringify(table);

  return `(function() {
  // BugHunter V23 timezone polyfill — zone: ${tzId}
  // Decision: addInitScript-based because BrowserContext.setTimezoneId is creation-time-only
  // on Firefox and CDP Emulation.setTimezoneOverride is Chromium-only.

  const TZ_ID = ${JSON.stringify(tzId)};
  // Offset table: sorted array of [unixMs, offsetMinutes].
  // offsetMinutes = zoneLocalMs - utcMs in minutes (positive east of UTC).
  // getTimezoneOffset returns the negation of this.
  const OFFSET_TABLE = ${tableJson};

  function getOffsetMinutes(unixMs) {
    let lo = 0, hi = OFFSET_TABLE.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (OFFSET_TABLE[mid][0] <= unixMs) lo = mid;
      else hi = mid - 1;
    }
    return OFFSET_TABLE[lo][1];
  }

  // Patch getTimezoneOffset (returns utc - local in minutes, i.e. negative of offsetMinutes)
  const _getTimezoneOffset = Date.prototype.getTimezoneOffset;
  Date.prototype.getTimezoneOffset = function() {
    return -getOffsetMinutes(this.valueOf());
  };

  // Patch toString to render in the target zone
  const _nativeToLocaleString = Date.prototype.toLocaleString;
  const _nativeToLocaleDateString = Date.prototype.toLocaleDateString;
  const _nativeToLocaleTimeString = Date.prototype.toLocaleTimeString;
  const _nativeToString = Date.prototype.toString;

  Date.prototype.toString = function() {
    try {
      return this.toLocaleString('en-US', { timeZone: TZ_ID, hour12: false,
        weekday: 'short', year: 'numeric', month: 'short', day: '2-digit',
        hour: '2-digit', minute: '2-digit', second: '2-digit',
        timeZoneName: 'short' });
    } catch(e) { return _nativeToString.call(this); }
  };

  Date.prototype.toLocaleString = function(locale, opts) {
    const o = Object.assign({ timeZone: TZ_ID }, opts || {});
    return _nativeToLocaleString.call(this, locale, o);
  };

  Date.prototype.toLocaleDateString = function(locale, opts) {
    const o = Object.assign({ timeZone: TZ_ID }, opts || {});
    return _nativeToLocaleDateString.call(this, locale, o);
  };

  Date.prototype.toLocaleTimeString = function(locale, opts) {
    const o = Object.assign({ timeZone: TZ_ID }, opts || {});
    return _nativeToLocaleTimeString.call(this, locale, o);
  };

  // Patch Intl.DateTimeFormat to default timeZone to TZ_ID when not specified
  const _NativeDTF = Intl.DateTimeFormat;
  function PatchedDateTimeFormat(locale, opts) {
    const o = Object.assign({ timeZone: TZ_ID }, opts || {});
    return new _NativeDTF(locale, o);
  }
  PatchedDateTimeFormat.prototype = _NativeDTF.prototype;
  PatchedDateTimeFormat.supportedLocalesOf = _NativeDTF.supportedLocalesOf.bind(_NativeDTF);
  Intl.DateTimeFormat = PatchedDateTimeFormat;
})();`;
}
