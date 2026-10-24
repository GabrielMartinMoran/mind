// ── Shared MCP date-range filtering ──
//
// Mind stores `changed_at` as a zone-less UTC string ("YYYY-MM-DD HH:MM:SS").
// JavaScript parses that form as local time, so every bound and timestamp is
// resolved through the store's canonical UTC parser (`parseUtcBound`) instead
// of the host timezone. Both `checkpoint_query` and `memory_query` share this
// implementation. The store query path calls the same parser and the same
// whole-second resolution, so a given bound selects the same rows on both
// paths.

import { normalizeDateBound, parseUtcBound } from '../../store/shared/datetime-helpers';

interface DatedValue {
  changed_at: string;
}

/**
 * Resolve one raw bound to whole-second epoch milliseconds.
 *
 * `normalizeDateBound` is the canonical parser used by the store query path, so
 * an unparseable bound throws the same `Invalid date value: <raw>` error on
 * both paths instead of quietly selecting no rows.
 */
function resolveBound(raw: string, endOfDay: boolean): number {
  const normalized = normalizeDateBound(raw, endOfDay);
  return parseUtcBound(normalized, false).getTime();
}

/**
 * Return the items whose UTC `changed_at` falls inside the inclusive bounds.
 *
 * Bounds and timestamps are parsed by {@link parseUtcBound}: date-only bounds
 * cover their full UTC day, zone-less date-times are read as UTC, explicit
 * zones are converted to UTC, and fractional seconds floor to the whole second
 * used by `changed_at`. Passing neither bound returns the list unchanged; an
 * invalid bound throws `Invalid date value: <raw>`, matching the store path.
 */
export function filterByDateRange<T extends DatedValue>(
  items: T[],
  from?: string,
  to?: string
): T[] {
  if (!from && !to) {
    return items;
  }

  const fromTime = from ? resolveBound(from, false) : null;
  const toTime = to ? resolveBound(to, true) : null;

  return items.filter(item => {
    const changed = parseUtcBound(item.changed_at, false).getTime();
    if (Number.isNaN(changed)) {
      return false;
    }
    if (fromTime !== null && changed < fromTime) {
      return false;
    }
    if (toTime !== null && changed > toTime) {
      return false;
    }
    return true;
  });
}
