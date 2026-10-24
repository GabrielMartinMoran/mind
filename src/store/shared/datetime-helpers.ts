// ── Datetime helper functions ──

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
const EXPLICIT_ZONE = /(?:[zZ]|[+-]\d{2}:?\d{2})$/;

/**
 * Return current timestamp in SQLite DATETIME format (YYYY-MM-DD HH:MM:SS).
 */
export function now(): string {
  return new Date().toISOString().replace('T', ' ').replace('Z', '').split('.')[0]!;
}

/**
 * Parse a query bound as UTC.
 *
 * A date-only `from` starts at 00:00:00 and a date-only `to` ends at 23:59:59
 * of that same UTC day. A bound that carries a time is honored exactly as UTC
 * and is never widened. Inputs that name an explicit zone are converted to UTC.
 */
function parseUtcBound(raw: string, endOfDay: boolean): Date {
  const text = raw.trim();

  if (DATE_ONLY.test(text)) {
    return new Date(`${text}T${endOfDay ? '23:59:59' : '00:00:00'}Z`);
  }

  if (EXPLICIT_ZONE.test(text)) {
    return new Date(text);
  }

  // Zone-less forms such as "YYYY-MM-DD HH:MM:SS" would otherwise parse as
  // local time; treat them as UTC so results do not depend on the host zone.
  return new Date(`${text.replace(' ', 'T')}Z`);
}

/**
 * Normalize a date bound (from/to) to the zone-less UTC storage format
 * (`YYYY-MM-DD HH:MM:SS`), which is lexicographically comparable with
 * `changed_at`.
 * @param raw - the raw date string
 * @param endOfDay - if true, a date-only value resolves to 23:59:59 instead of
 *   00:00:00; a value that already carries a time is left unchanged
 */
export function normalizeDateBound(raw: string, endOfDay = false): string {
  const parsed = parseUtcBound(raw, endOfDay);

  if (Number.isNaN(parsed.getTime())) {
    throw new Error(`Invalid date value: ${raw}`);
  }

  return parsed.toISOString().slice(0, 19).replace('T', ' ');
}
