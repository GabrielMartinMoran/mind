// ── Shared MCP date-range filtering ──
//
// Mind stores `changed_at` as a zone-less UTC string ("YYYY-MM-DD HH:MM:SS").
// JavaScript parses that form as local time, while a date-only bound parses as
// UTC midnight. Mixing the two makes results depend on the host timezone, so
// every bound and timestamp is normalized to UTC here and both `checkpoint_query`
// and `memory_query` share this single implementation.

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

interface DatedValue {
  changed_at: string;
}

/**
 * Parse a Mind timestamp as UTC. Values that already carry a `T` separator or a
 * trailing `Z` are honored as-is; the zone-less storage form gets an explicit Z.
 */
function parseUtcTimestamp(raw: string): number {
  const text = raw.trim();
  if (text.includes('T') || text.endsWith('Z')) {
    return new Date(text).getTime();
  }
  return new Date(`${text.replace(' ', 'T')}Z`).getTime();
}

/**
 * Parse a query bound as UTC. A date-only `from` starts at 00:00:00.000 and a
 * date-only `to` ends at 23:59:59.999 of that same UTC day. A bound that carries
 * a time is honored exactly as UTC and is never widened.
 */
function parseUtcBound(raw: string, endOfDay: boolean): number {
  const text = raw.trim();
  if (DATE_ONLY.test(text)) {
    return new Date(`${text}T${endOfDay ? '23:59:59.999' : '00:00:00.000'}Z`).getTime();
  }
  return parseUtcTimestamp(text);
}

/**
 * Return the items whose UTC `changed_at` falls inside the inclusive bounds.
 * Passing neither bound returns the list unchanged; invalid bounds exclude all
 * items, matching the previous filter behavior instead of silently widening.
 */
export function filterByDateRange<T extends DatedValue>(
  items: T[],
  from?: string,
  to?: string
): T[] {
  if (!from && !to) {
    return items;
  }

  const fromTime = from ? parseUtcBound(from, false) : null;
  const toTime = to ? parseUtcBound(to, true) : null;

  return items.filter(item => {
    const changed = parseUtcTimestamp(item.changed_at);
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
