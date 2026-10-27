// Experiment A — deterministic query strategies (no LLM, no gold).
//
// Each strategy rewrites a natural-language benchmark question into 1..2 search
// queries using ONLY the question text and the participant names derivable from
// the ingested conversation data. The expected answer / gold evidence is NEVER
// an input, and there are no per-conversation hardcoded keyword lists.
//
// Safeguard: if the question already carries explicit query syntax the parser
// understands (uppercase AND/OR/NOT, `"phrases"`, or `term*` prefixes) the
// strategy leaves it untouched and records why. This keeps a user-authored query
// authoritative instead of silently rewriting it.

/** Strategy identifiers, in report order. */
export type StrategyId = 'S1' | 'S2' | 'S3' | 'S4' | 'S5' | 'S6';

export interface StrategyContext {
  /**
   * Participant names derivable from the ingested conversation (LoCoMo
   * `speaker_a` / `speaker_b`, which also prefix every ingested turn). Used by
   * the entity strategy; never a hardcoded per-conversation list.
   */
  readonly participants: readonly string[];
}

export interface StrategyResult {
  readonly id: StrategyId;
  /** 1..2 queries, deterministic order (target ≥1). */
  readonly queries: readonly string[];
  /** True when `queries` differs from the original question. */
  readonly rewritten: boolean;
  /** Deterministic human-readable reason for the decision. */
  readonly reason: string;
}

export interface StrategyDefinition {
  readonly id: StrategyId;
  readonly label: string;
  readonly description: string;
}

export const STRATEGIES: readonly StrategyDefinition[] = [
  {
    id: 'S1',
    label: 'original',
    description: 'The question verbatim (baseline).',
  },
  {
    id: 'S2',
    label: 'content-only',
    description: 'Conservative function-word drop; content words kept in order.',
  },
  {
    id: 'S3',
    label: 'entities',
    description:
      'Generic entity extraction: non-sentence-initial capitalized tokens, quoted strings, numbers, and participant names.',
  },
  {
    id: 'S4',
    label: 'entities+content',
    description: 'Deduped union of the entity tokens and the content-word tokens.',
  },
  {
    id: 'S5',
    label: 'two-query (entity ∪ content)',
    description: 'Two complementary queries (entity-focused + content-focused), results unioned.',
  },
  {
    id: 'S6',
    label: 'two-query (combined ∪ entity)',
    description:
      'Deduped union of the combined query (S4) and the entity query (S3) — 2 queries, the closest ≤2-query proxy for the S2..S5 union.',
  },
];

// ── Safeguard: explicit query syntax ──

const OPERATOR_RE = /(^|\s)(AND|OR|NOT)(?=\s|$)/;
const PHRASE_RE = /"[^"]*"/;
const PREFIX_RE = /(^|\s)[\p{L}\p{N}_]+\*/u;

/** True when the text already carries explicit query syntax the parser honors. */
export function hasExplicitSyntax(question: string): boolean {
  return OPERATOR_RE.test(question) || PHRASE_RE.test(question) || PREFIX_RE.test(question);
}

// ── Tokenization / stopwords ──

/**
 * Small curated English function-word list. Conservative on purpose: negations
 * (`no`, `not`, `nor`) and interrogatives that could name something are left in,
 * and capitalized tokens are never dropped (they may be proper nouns).
 */
export const STOPWORDS: ReadonlySet<string> = new Set([
  'a',
  'an',
  'the',
  'and',
  'or',
  'but',
  'if',
  'then',
  'than',
  'so',
  'of',
  'to',
  'in',
  'on',
  'at',
  'by',
  'for',
  'with',
  'about',
  'into',
  'over',
  'after',
  'before',
  'between',
  'during',
  'from',
  'up',
  'down',
  'again',
  'here',
  'there',
  'when',
  'where',
  'how',
  'all',
  'any',
  'both',
  'each',
  'few',
  'more',
  'most',
  'other',
  'some',
  'such',
  'own',
  'same',
  'too',
  'very',
  'is',
  'are',
  'was',
  'were',
  'be',
  'been',
  'being',
  'do',
  'does',
  'did',
  'doing',
  'what',
  'which',
  'who',
  'whom',
  'this',
  'that',
  'these',
  'those',
]);

/** Strip surrounding punctuation for stopword comparison, keeping inner chars. */
function normalizeToken(token: string): string {
  return token
    .replace(/^[^\p{L}\p{N}]+/u, '')
    .replace(/[^\p{L}\p{N}]+$/u, '')
    .toLowerCase();
}

/** Words of the question with their original spelling (whitespace split). */
export function words(question: string): string[] {
  return question.split(/\s+/).filter(token => token.length > 0);
}

function isCapitalized(token: string): boolean {
  const first = token.match(/\p{L}/u)?.[0];
  return first !== undefined && first === first.toUpperCase() && first !== first.toLowerCase();
}

/** S2 core: drop conservative function words, keep capitalized/content tokens. */
export function contentWords(question: string): string[] {
  const kept: string[] = [];
  for (const token of words(question)) {
    const lowered = normalizeToken(token);
    if (lowered.length === 0) continue;
    if (STOPWORDS.has(lowered) && !isCapitalized(token)) continue;
    kept.push(token);
  }
  return kept;
}

/** S3 core: generic entity-like tokens, in original order, deduped. */
export function entityTokens(question: string, ctx: StrategyContext): string[] {
  const tokens = words(question);
  const participants = new Set(ctx.participants.map(name => name.toLowerCase()));
  const entities: string[] = [];

  // Quoted strings (only reachable when the safeguard did not short-circuit).
  for (const quoted of question.matchAll(/"([^"]+)"/g)) {
    const inner = quoted[1];
    if (inner && inner.trim()) entities.push(inner.trim());
  }

  tokens.forEach((token, index) => {
    const lowered = normalizeToken(token);
    if (lowered.length === 0) return;
    if (participants.has(lowered)) {
      entities.push(token);
      return;
    }
    if (/\d/.test(token)) {
      entities.push(token);
      return;
    }
    // Capitalized and not sentence-initial (the first token is always
    // capitalized in an English question and is usually an interrogative).
    if (index > 0 && isCapitalized(token) && !STOPWORDS.has(lowered)) {
      entities.push(token);
    }
  });

  return dedupe(entities);
}

export function dedupe(tokens: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const token of tokens) {
    const key = token.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(token);
  }
  return out;
}

// ── Strategy application ──

function applyCore(id: StrategyId, question: string, ctx: StrategyContext): StrategyResult {
  const original: StrategyResult = {
    id,
    queries: [question],
    rewritten: false,
    reason: 'original',
  };

  if (hasExplicitSyntax(question)) {
    return { ...original, reason: 'explicit_operator_preserved' };
  }

  switch (id) {
    case 'S1':
      return original;

    case 'S2': {
      const kept = contentWords(question);
      if (kept.length === 0 || kept.length === words(question).length) {
        return { ...original, reason: kept.length === 0 ? 'stopword_empty_fallback' : 'no_change' };
      }
      return {
        id,
        queries: [kept.join(' ')],
        rewritten: true,
        reason: 'stopword_drop',
      };
    }

    case 'S3': {
      const entities = entityTokens(question, ctx);
      if (entities.length === 0) {
        return { ...original, reason: 'entity_empty_fallback' };
      }
      return {
        id,
        queries: [entities.join(' ')],
        rewritten: true,
        reason: 'entity_extraction',
      };
    }

    case 'S4': {
      const combined = dedupe([...entityTokens(question, ctx), ...contentWords(question)]);
      if (combined.length === 0) return { ...original, reason: 'combined_empty_fallback' };
      return {
        id,
        queries: [combined.join(' ')],
        rewritten: combined.join(' ') !== question,
        reason: 'entity_plus_content',
      };
    }

    case 'S5': {
      const entityQuery = entityTokens(question, ctx).join(' ');
      const contentQuery = contentWords(question).join(' ');
      const queries = dedupeQueries([entityQuery, contentQuery]);
      if (queries.length === 0) return { ...original, reason: 'two_query_empty_fallback' };
      return {
        id,
        queries,
        rewritten: queries.length !== 1 || queries[0] !== question,
        reason: 'complementary_union',
      };
    }

    case 'S6': {
      const combinedQuery = dedupe([
        ...entityTokens(question, ctx),
        ...contentWords(question),
      ]).join(' ');
      const entityQuery = entityTokens(question, ctx).join(' ');
      const queries = dedupeQueries([combinedQuery, entityQuery]);
      if (queries.length === 0) return { ...original, reason: 'combined_union_empty_fallback' };
      return {
        id,
        queries,
        rewritten: queries.length !== 1 || queries[0] !== question,
        reason: 'combined_union',
      };
    }
  }
}

function dedupeQueries(queries: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const query of queries) {
    const trimmed = query.trim();
    if (trimmed.length === 0) continue;
    if (seen.has(trimmed)) continue;
    seen.add(trimmed);
    out.push(trimmed);
  }
  return out;
}

/** Apply one strategy to one question. Pure and deterministic. */
export function applyStrategy(
  id: StrategyId,
  question: string,
  ctx: StrategyContext
): StrategyResult {
  return applyCore(id, question, ctx);
}

/** Build every strategy's result for one question (report order). */
export function applyAllStrategies(
  question: string,
  ctx: StrategyContext
): readonly StrategyResult[] {
  return STRATEGIES.map(strategy => applyStrategy(strategy.id, question, ctx));
}
