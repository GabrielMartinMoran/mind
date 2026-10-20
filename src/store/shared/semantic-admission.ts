// ── Independent semantic admission (D1) ──
//
// Semantic candidates are retrieved with a broad candidate floor (0.3). That
// floor is intentionally permissive because lexical channels still gate the
// result set. Once lexical admission is decoupled, a semantic-only candidate
// must clear a stricter, semantic-only admission floor: a weak cosine is noise,
// not relevance.
//
// These helpers are pure: they operate on the parsed query and on already
// filtered, already scored ids, and never touch SQL or the store.

import type { ParsedQuery } from './query-parser';

/**
 * Minimum cosine similarity for a semantic-only candidate to be admitted past
 * the lexical admission gate. Equal to the existing semantic "medium" floor.
 *
 * Kept as its own constant on purpose: `SEMANTIC_MEDIUM_FLOOR` in
 * `search-fusion.ts` is a presentation policy (confidence bucket), while this is
 * an admission policy. Sharing one constant would couple ranking presentation
 * to recall admission, so the two deliberately remain separate even though the
 * numeric values agree today.
 */
export const SEMANTIC_ADMISSION_FLOOR = 0.6;

/**
 * True when the query is a natural-language bag of words: exactly one positive
 * group, no NOT exclusions, and every node a plain (non-prefix) term.
 *
 * Explicit operators — quoted phrases, prefixes, OR, AND and NOT — express
 * lexical intent, so those queries keep the lexical admission path.
 */
export function canBypassLexicalAdmission(ast: ParsedQuery): boolean {
  if (ast.groups.length !== 1 || ast.exclude.length > 0) return false;
  return ast.groups[0]!.nodes.every(node => node.type === 'term' && !node.prefix);
}

/**
 * Ids whose semantic score clears `floor` and that are not excluded by NOT.
 * Returned in deterministic id order so callers can build stable result sets.
 */
export function selectSemanticAdmittedIds(
  semanticScores: ReadonlyMap<string, number>,
  excludedIds: ReadonlySet<string>,
  floor: number = SEMANTIC_ADMISSION_FLOOR
): string[] {
  const admitted: string[] = [];
  for (const [id, score] of semanticScores) {
    if (Number.isFinite(score) && score >= floor && !excludedIds.has(id)) admitted.push(id);
  }
  return admitted.sort();
}
