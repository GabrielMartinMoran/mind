// ── Shared MCP date-range filtering ──
//
// Mind stores `changed_at` as a zone-less UTC string ("YYYY-MM-DD HH:MM:SS").
// JavaScript parses that form as local time, so every bound and timestamp is
// resolved through the store's canonical UTC parser (`parseUtcBound`) instead
// of the host timezone. Both `checkpoint_query` and `memory_query` share this
// implementation, and it cannot diverge from the store query path because both
// use the same parser.

import { parseUtcBound } from '../../store/shared/datetime-helpers';

interface DatedValue {
  changed_at: string;
}

/**
 * Return the items whose UTC `changed_at` falls inside the inclusive bounds.
 *
 * Bounds and timestamps are parsed by {@link parseUtcBound}: date-only bounds
 * cover their full UTC day, zone-less date-times are read as UTC, and explicit
 * zones are converted to UTC. Passing neither bound returns the list unchanged;
 * an invalid bound excludes all items, matching the previous filter behavior
 * instead of silently widening.
 */
export function filterByDateRange<T extends DatedValue>(
  items: T[],
  from?: string,
  to?: string
): T[] {
  if (!from && !to) {
    return items;
  }

  const fromTime = from ? parseUtcBound(from, false).getTime() : null;
  const toTime = to ? parseUtcBound(to, true).getTime() : null;

  return items.filter(item => {
    const changed = parseUtcBound(item.changed_at, false).getTime();
    if (Number.isNaN(changed)) {
      return false;
    }
    if (fromTime !== null && (Number.isNaN(fromTime) || changed < fromTime)) {
      return false;
    }
    if (toTime !== null && (Number.isNaN(toTime) || changed > toTime)) {
      return false;
    }
    return true;
  });
}
