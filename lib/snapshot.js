/**
 * Snapshot windowing — truncate large accessibility snapshots while
 * preserving pagination/navigation links at the tail.
 */

const MAX_SNAPSHOT_CHARS = 80000;  // ~20K tokens
const SNAPSHOT_TAIL_CHARS = 5000;  // keep last ~5K for pagination/nav links

/**
 * Return a window of the snapshot YAML.
 *  offset=0 (default): head chunk + tail (pagination/nav).
 *  offset=N: chars N..N+budget from the full snapshot.
 *  Always appends pagination tail so nav refs are available in every chunk.
 */
function windowSnapshot(yaml, offset = 0) {
  if (!yaml) return { text: '', truncated: false, totalChars: 0, offset: 0 };
  const total = yaml.length;
  if (total <= MAX_SNAPSHOT_CHARS) return { text: yaml, truncated: false, totalChars: total, offset: 0 };

  const contentBudget = MAX_SNAPSHOT_CHARS - SNAPSHOT_TAIL_CHARS - 200; // room for marker
  const tail = yaml.slice(-SNAPSHOT_TAIL_CHARS);
  const clampedOffset = Math.min(Math.max(0, offset), total - SNAPSHOT_TAIL_CHARS);
  const chunk = yaml.slice(clampedOffset, clampedOffset + contentBudget);
  const chunkEnd = clampedOffset + contentBudget;
  const hasMore = chunkEnd < total - SNAPSHOT_TAIL_CHARS;

  const marker = hasMore
    ? `\n[... truncated at char ${chunkEnd} of ${total}. Call snapshot with offset=${chunkEnd} to see more. Pagination links below. ...]\n`
    : '\n';

  return {
    text: chunk + marker + tail,
    truncated: true,
    totalChars: total,
    offset: clampedOffset,
    hasMore,
    nextOffset: hasMore ? chunkEnd : null
  };
}

module.exports = { windowSnapshot, MAX_SNAPSHOT_CHARS, SNAPSHOT_TAIL_CHARS };
