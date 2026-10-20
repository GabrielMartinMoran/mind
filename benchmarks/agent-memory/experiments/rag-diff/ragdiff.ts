// E-RAG pure analysis helpers: semantic vs lexical retrieved-set diff.
//
// Everything here is deterministic and free of I/O, clock, network and LLM
// calls. Gold evidence is only used for scoring/attribution, never to build a
// query.
//
// Definitions:
//   * `setDiff` compares the first-K unique names returned by the RAG-off
//     (lexical) and RAG-on (lexical + semantic) DBs.
//   * `attributeEvidence` classifies each gold item as retrieved by both
//     windows, only by lexical, only by semantic, or by neither.
//   * `displacement` labels what left the top-K (displaced) and what entered
//     it (inserted), with enough metadata to tell gold/high-confidence lexical
//     items from weak semantic insertions.

export interface RankedItem {
  readonly name: string;
  readonly content: string;
  readonly score?: number | null;
  readonly confidence?: string | null;
  readonly methods?: readonly string[] | null;
}

export interface SetDiff {
  readonly intersection: readonly string[];
  readonly offOnly: readonly string[];
  readonly onOnly: readonly string[];
  readonly jaccard: number;
}

/** First `k` unique names, preserving rank order. */
export function topNames(names: readonly string[], k: number): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  const limit = Math.max(0, k);
  for (const name of names) {
    if (seen.has(name)) continue;
    seen.add(name);
    out.push(name);
    if (out.length >= limit) break;
  }
  return out;
}

function topItems(items: readonly RankedItem[], k: number): RankedItem[] {
  const seen = new Set<string>();
  const out: RankedItem[] = [];
  const limit = Math.max(0, k);
  for (const item of items) {
    if (seen.has(item.name)) continue;
    seen.add(item.name);
    out.push(item);
    if (out.length >= limit) break;
  }
  return out;
}

export function setDiff(
  offNames: readonly string[],
  onNames: readonly string[],
  k: number
): SetDiff {
  const off = topNames(offNames, k);
  const on = topNames(onNames, k);
  const offSet = new Set(off);
  const onSet = new Set(on);
  const intersection = off.filter(name => onSet.has(name));
  const offOnly = off.filter(name => !onSet.has(name));
  const onOnly = on.filter(name => !offSet.has(name));
  const union = new Set([...off, ...on]);
  return {
    intersection,
    offOnly,
    onOnly,
    jaccard: union.size === 0 ? 1 : intersection.length / union.size,
  };
}

export interface EvidenceAttribution {
  /** Gold items present in both top-K windows. */
  readonly both: readonly string[];
  /** Gold items retrieved lexically (OFF) but not semantically (ON). */
  readonly lexical_only: readonly string[];
  /** Gold items retrieved only by the RAG-ON window. */
  readonly semantic_only: readonly string[];
  /** Gold items absent from both top-K windows. */
  readonly neither: readonly string[];
}

export function attributeEvidence(
  offNames: readonly string[],
  onNames: readonly string[],
  gold: readonly string[],
  k: number
): EvidenceAttribution {
  const off = new Set(topNames(offNames, k));
  const on = new Set(topNames(onNames, k));
  const both: string[] = [];
  const lexicalOnly: string[] = [];
  const semanticOnly: string[] = [];
  const neither: string[] = [];
  for (const name of topNames(gold, gold.length)) {
    const inOff = off.has(name);
    const inOn = on.has(name);
    if (inOff && inOn) both.push(name);
    else if (inOff) lexicalOnly.push(name);
    else if (inOn) semanticOnly.push(name);
    else neither.push(name);
  }
  return {
    both,
    lexical_only: lexicalOnly,
    semantic_only: semanticOnly,
    neither,
  };
}

export interface AttributionSummary {
  readonly items: number;
  readonly both: number;
  readonly lexical_only: number;
  readonly semantic_only: number;
  readonly neither: number;
}

export function summarizeAttribution(
  attributions: readonly EvidenceAttribution[]
): AttributionSummary {
  const total = (key: keyof EvidenceAttribution): number =>
    attributions.reduce((sum, attribution) => sum + attribution[key].length, 0);
  return {
    items: total('both') + total('lexical_only') + total('semantic_only') + total('neither'),
    both: total('both'),
    lexical_only: total('lexical_only'),
    semantic_only: total('semantic_only'),
    neither: total('neither'),
  };
}

export interface DisplacedItem {
  readonly name: string;
  readonly direction: 'displaced' | 'inserted';
  /** 1-based rank inside the OFF top-K, or null. */
  readonly offRank: number | null;
  /** 1-based rank inside the ON top-K, or null. */
  readonly onRank: number | null;
  /** 1-based rank inside the OFF top-25 window, or null. */
  readonly offRank25: number | null;
  /** 1-based rank inside the ON top-25 window, or null. */
  readonly onRank25: number | null;
  readonly isGold: boolean;
  readonly confidence: string | null;
  readonly methods: readonly string[];
  readonly semantic: boolean;
}

export interface Displacement {
  readonly displaced: readonly DisplacedItem[];
  readonly inserted: readonly DisplacedItem[];
}

function rankIn(names: readonly string[], name: string): number | null {
  const index = names.indexOf(name);
  return index >= 0 ? index + 1 : null;
}

function describe(
  item: RankedItem,
  direction: DisplacedItem['direction'],
  offTop: readonly string[],
  onTop: readonly string[],
  off25: readonly string[],
  on25: readonly string[],
  gold: ReadonlySet<string>
): DisplacedItem {
  const methods = Array.isArray(item.methods) ? item.methods : [];
  return {
    name: item.name,
    direction,
    offRank: rankIn(offTop, item.name),
    onRank: rankIn(onTop, item.name),
    offRank25: rankIn(off25, item.name),
    onRank25: rankIn(on25, item.name),
    isGold: gold.has(item.name),
    confidence: item.confidence ?? null,
    methods,
    semantic: methods.includes('semantic'),
  };
}

/**
 * Items pushed out of the top-K by the RAG-ON ranking (`displaced`) and items
 * that entered it (`inserted`). The K=25 windows are used only to tell a true
 * insertion from a re-ranking of an item both DBs already found deeper.
 */
export function displacement(
  off: readonly RankedItem[],
  on: readonly RankedItem[],
  gold: readonly string[],
  off25: readonly string[],
  on25: readonly string[],
  k: number
): Displacement {
  const offTopItems = topItems(off, k);
  const onTopItems = topItems(on, k);
  const offTop = offTopItems.map(item => item.name);
  const onTop = onTopItems.map(item => item.name);
  const offSet = new Set(offTop);
  const onSet = new Set(onTop);
  const goldSet = new Set(gold);
  return {
    displaced: offTopItems
      .filter(item => !onSet.has(item.name))
      .map(item => describe(item, 'displaced', offTop, onTop, off25, on25, goldSet)),
    inserted: onTopItems
      .filter(item => !offSet.has(item.name))
      .map(item => describe(item, 'inserted', offTop, onTop, off25, on25, goldSet)),
  };
}

export interface DisplacementStats {
  readonly displaced: number;
  readonly displacedGold: number;
  readonly displacedHighConfidenceLexical: number;
  readonly inserted: number;
  readonly insertedNonGold: number;
  readonly insertedWithSemantic: number;
  readonly insertedSemanticOnlyWindow: number;
  readonly netGold: number;
}

/** Aggregate displacement counts used by the report tables. */
export function paidStats(diff: Displacement): DisplacementStats {
  const insertedNonGold = diff.inserted.filter(item => !item.isGold);
  return {
    displaced: diff.displaced.length,
    displacedGold: diff.displaced.filter(item => item.isGold).length,
    displacedHighConfidenceLexical: diff.displaced.filter(
      item => !item.isGold && item.confidence === 'high'
    ).length,
    inserted: diff.inserted.length,
    insertedNonGold: insertedNonGold.length,
    insertedWithSemantic: diff.inserted.filter(item => item.semantic).length,
    insertedSemanticOnlyWindow: insertedNonGold.filter(
      item => item.semantic && item.offRank25 === null
    ).length,
    netGold:
      diff.inserted.filter(item => item.isGold).length -
      diff.displaced.filter(item => item.isGold).length,
  };
}

export interface LatencyStats {
  readonly n: number;
  readonly mean: number | null;
  readonly p50: number | null;
  readonly p95: number | null;
  readonly min: number | null;
  readonly max: number | null;
}

/** Nearest-rank percentile (same convention as the earlier experiments). */
export function percentile(values: readonly number[], p: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))] ?? null;
}

export function latencyStats(values: readonly number[]): LatencyStats {
  if (values.length === 0) {
    return { n: 0, mean: null, p50: null, p95: null, min: null, max: null };
  }
  const sum = values.reduce((total, value) => total + value, 0);
  return {
    n: values.length,
    mean: sum / values.length,
    p50: percentile(values, 50),
    p95: percentile(values, 95),
    min: Math.min(...values),
    max: Math.max(...values),
  };
}

/** Per-probe ON − OFF latency deltas (same probe order). */
export function pairedDeltas(off: readonly number[], on: readonly number[]): number[] {
  const length = Math.min(off.length, on.length);
  const out: number[] = [];
  for (let index = 0; index < length; index += 1) {
    out.push(on[index]! - off[index]!);
  }
  return out;
}

/** USD cost for a measured token count at a per-million-token price. */
export function estimateCostUsd(tokens: number, pricePerMillionUsd: number): number {
  return (tokens / 1_000_000) * pricePerMillionUsd;
}

/** Count probes whose retrieved gold set improved/worsened between windows. */
export function goldFlip(
  offNames: readonly string[],
  onNames: readonly string[],
  gold: readonly string[],
  k: number
): { gained: readonly string[]; lost: readonly string[] } {
  const off = new Set(topNames(offNames, k));
  const on = new Set(topNames(onNames, k));
  const offGold = new Set(gold.filter(item => off.has(item)));
  const onGold = new Set(gold.filter(item => on.has(item)));
  return {
    gained: [...onGold].filter(item => !offGold.has(item)),
    lost: [...offGold].filter(item => !onGold.has(item)),
  };
}
