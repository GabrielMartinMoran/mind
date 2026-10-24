import type { Tier } from '../../types';

/** All tiers in ascending order. Selecting every tier means "no filter". */
const TIER_VALUES: readonly Tier[] = [1, 2, 3];

/** Parse one integer tier value, dropping anything outside 1..3. */
export function parseTier(raw: string | null): Tier | undefined {
  if (raw === null) return undefined;
  const n = Number(raw);
  if (Number.isInteger(n) && n >= 1 && n <= 3) return n as Tier;
  return undefined;
}

/**
 * Parse a comma-separated tier list. Invalid values are dropped, duplicates
 * removed, and the result ordered 1..3. An empty result means the parameter
 * carried no usable value.
 */
export function parseTierList(raw: string | null): Tier[] {
  if (!raw) return [];
  const seen = new Set<Tier>();
  for (const part of raw.split(',')) {
    const tier = parseTier(part.trim());
    if (tier !== undefined) seen.add(tier);
  }
  return [...seen].sort((a, b) => a - b);
}

/** Tier restriction resolved from the query string. */
export interface TierFilter {
  /** Single-tier compatibility form, used when exactly one tier is selected. */
  tier?: Tier;
  /** Inclusive multi-tier form. Omitted when every tier is selected. */
  tiers?: Tier[];
}

/**
 * Resolve `tiers` then `tier` from a request. `tiers` takes precedence when it
 * contains at least one valid value; otherwise the legacy `tier` is used.
 * Selecting all three tiers yields an empty filter (no restriction).
 */
export function resolveTierFilter(params: URLSearchParams): TierFilter {
  const tiers = parseTierList(params.get('tiers'));
  if (tiers.length === TIER_VALUES.length) return {};
  if (tiers.length > 0) return { tiers };

  const tier = parseTier(params.get('tier'));
  return tier !== undefined ? { tier } : {};
}
