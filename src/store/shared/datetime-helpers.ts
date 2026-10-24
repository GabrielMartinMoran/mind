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
 * Parse a date/time bound as UTC. This is the single parser shared by the store
 * query path and the MCP date-range filter, so both resolve every accepted
 * spelling to the same instant regardless of the host timezone.
 *
 * Resolution rules:
 * - A date-only `YYYY-MM-DD` bound resolves to 00:00:00 of that UTC day, or to
 *   23:59:59 when `endOfDay` is true.
 * - A zone-less date-time (`YYYY-MM-DD HH:MM:SS` or `YYYY-MM-DDTHH:MM:SS`) is
 *   read as UTC.
 * - An explicit zone (trailing `Z`, or an offset `±HH:MM` / `±HHMM` with either
 *   a `T` or a space separator) is honored and converted to UTC.
 * - Fractional seconds are floored to the whole second. `changed_at` is stored
 *   at second precision, so every consumer compares whole-second bounds and
 *   both the SQL text comparison and the in-memory millisecond comparison see
 *   the same instant.
 * - Any other value yields an invalid `Date` (never a host-local guess).
 *
 * @param raw - the raw date string
 * @param endOfDay - if true, a date-only value resolves to 23:59:59 instead of
 *   00:00:00; a value that already carries a time is unaffected
 */
export function parseUtcBound(raw: string, endOfDay = false): Date {
  const text = raw.trim();

  let parsed: Date;
  if (DATE_ONLY.test(text)) {
    parsed = new Date(`${text}T${endOfDay ? '23:59:59' : '00:00:00'}Z`);
  } else if (EXPLICIT_ZONE.test(text)) {
    // Normalize a space separator to `T` so every engine honors the offset.
    parsed = new Date(text.replace(' ', 'T'));
  } else {
    // Zone-less forms such as "YYYY-MM-DD HH:MM:SS" would otherwise parse as
    // local time; treat them as UTC so results do not depend on the host zone.
    parsed = new Date(`${text.replace(' ', 'T')}Z`);
  }

  if (!Number.isNaN(parsed.getTime())) {
    // `changed_at` has no sub-second component, so floor the bound to a whole
    // second. Doing this once here keeps the store and MCP paths identical.
    parsed.setUTCMilliseconds(0);
  }

  return parsed;
}

/**
 * Normalize a date bound (from/to) to the zone-less UTC storage format
 * (`YYYY-MM-DD HH:MM:SS`), which is lexicographically comparable with
 * `changed_at`. Parsing rules are those of {@link parseUtcBound}.
 * @param raw - the raw date string
 * @param endOfDay - if true, a date-only value resolves to 23:59:59 instead of
 *   00:00:00; a value that already carries a time is left unchanged
 * @throws when the input cannot be parsed as a date bound
 */
export function normalizeDateBound(raw: string, endOfDay = false): string {
  const parsed = parseUtcBound(raw, endOfDay);

  if (Number.isNaN(parsed.getTime())) {
    throw new Error(`Invalid date value: ${raw}`);
  }

  return parsed.toISOString().slice(0, 19).replace('T', ' ');
}
