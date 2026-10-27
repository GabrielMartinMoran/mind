// @ts-check

/**
 * Pure memory-list helpers: tier grouping, filtering, sorting, pagination and
 * tier labels. No DOM, no fetch, no global state.
 */

/** @typedef {1 | 2 | 3} Tier */
/**
 * @typedef {{
 *   tier?: Tier | number,
 *   name?: string,
 *   tags?: string[],
 *   content?: string,
 *   changed_at?: string,
 * }} MemoryLike
 */

const TIER_LABELS = /** @type {Record<number, string>} */ ({
  1: 'T1 — Hot',
  2: 'T2 — Warm',
  3: 'T3 — Cold',
});

/**
 * Label a tier for display. Unknown tiers render as an empty string so callers
 * can keep their existing fallback behavior.
 *
 * @param {number | null | undefined} tier
 * @returns {string}
 */
export function tierLabel(tier) {
  if (tier == null) return '';
  return TIER_LABELS[tier] ?? '';
}

/**
 * Group memories into stable T1/T2/T3 buckets, preserving input order within
 * each bucket.
 *
 * @param {readonly MemoryLike[]} memories
 * @returns {{ 1: MemoryLike[], 2: MemoryLike[], 3: MemoryLike[] }}
 */
export function groupMemoriesByTier(memories) {
  /** @type {{ 1: MemoryLike[], 2: MemoryLike[], 3: MemoryLike[] }} */
  const groups = { 1: [], 2: [], 3: [] };
  for (const memory of memories ?? []) {
    if (memory.tier === 1 || memory.tier === 2 || memory.tier === 3) {
      groups[memory.tier].push(memory);
    }
  }
  return groups;
}

/**
 * Filter memories by tier, exact tag, and a case-insensitive text query across
 * name, tags and content (when present).
 *
 * @param {readonly MemoryLike[]} memories
 * @param {{ tier?: Tier|number|null, tag?: string|null, query?: string|null }} [filters]
 * @returns {MemoryLike[]}
 */
export function filterMemories(memories, filters = {}) {
  const { tier, tag, query } = filters;
  const normalizedTag = typeof tag === 'string' ? tag.trim().toLowerCase() : '';
  const normalizedQuery = typeof query === 'string' ? query.trim().toLowerCase() : '';
  const tierFilter = tier === 1 || tier === 2 || tier === 3 ? tier : null;

  return (memories ?? []).filter(memory => {
    if (tierFilter !== null && memory.tier !== tierFilter) return false;

    if (normalizedTag) {
      const tags = memory.tags ?? [];
      if (!tags.some(value => value.toLowerCase() === normalizedTag)) return false;
    }

    if (normalizedQuery) {
      const haystack = [memory.name ?? '', ...(memory.tags ?? []), memory.content ?? '']
        .join(' ')
        .toLowerCase();
      if (!haystack.includes(normalizedQuery)) return false;
    }

    return true;
  });
}

/** @param {MemoryLike} a @param {MemoryLike} b */
function compareNames(a, b) {
  const nameA = a.name ?? '';
  const nameB = b.name ?? '';
  return nameA < nameB ? -1 : nameA > nameB ? 1 : 0;
}

/**
 * Sort memories deterministically without mutating the input. The default is
 * name ascending; every mode breaks ties by name.
 *
 * @param {readonly MemoryLike[]} memories
 * @param {{ by?: 'name'|'tier'|'changed'|'changed_at' }} [options]
 * @returns {MemoryLike[]}
 */
export function sortMemories(memories, options = {}) {
  const by = options.by ?? 'name';
  return [...(memories ?? [])].sort((a, b) => {
    if (by === 'tier') {
      const tierA = typeof a.tier === 'number' ? a.tier : 0;
      const tierB = typeof b.tier === 'number' ? b.tier : 0;
      if (tierA !== tierB) return tierA - tierB;
    } else if (by === 'changed' || by === 'changed_at') {
      const timeA = a.changed_at ? Date.parse(a.changed_at) : Number.NaN;
      const timeB = b.changed_at ? Date.parse(b.changed_at) : Number.NaN;
      const validA = Number.isFinite(timeA);
      const validB = Number.isFinite(timeB);
      if (validA && validB && timeA !== timeB) return timeB - timeA;
      if (validA !== validB) return validA ? -1 : 1;
    }
    return compareNames(a, b);
  });
}

/**
 * Slice a page of memories and report whether more exist after it.
 *
 * @param {readonly MemoryLike[]} memories
 * @param {{ limit?: number, offset?: number }} [options]
 * @returns {{ items: MemoryLike[], total: number, hasMore: boolean }}
 */
export function paginateMemories(memories, options = {}) {
  const all = memories ?? [];
  const limit = Number.isFinite(options.limit) ? Math.max(0, Math.floor(options.limit)) : 30;
  const offset = Number.isFinite(options.offset) ? Math.max(0, Math.floor(options.offset)) : 0;
  const items = all.slice(offset, offset + limit);

  return {
    items,
    total: all.length,
    hasMore: offset + limit < all.length,
  };
}
