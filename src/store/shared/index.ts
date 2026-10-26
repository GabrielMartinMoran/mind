// ── Shared helpers barrel export ──

export { normalizeDateBound, now } from './datetime-helpers';
export { FtsHelper, recoverTrigramIndex, trigramIndexProblems } from './fts-helpers';
export {
  bumpStoreGeneration,
  foldedWords,
  normalizeToken,
  storeGeneration,
  stripDiacritics,
  tokenize,
} from './matching-tokenizer';
export {
  buildAnyMatch,
  buildPhraseMatch,
  buildPrimaryMatch,
  buildRungs,
  isEmptyQuery,
  parseQuery,
  type ParsedQuery,
  type QueryGroup,
  type QueryNode,
  type QueryRung,
  type RungMethod,
} from './query-parser';
export {
  AGREEMENT_BONUS_CAP,
  AGREEMENT_BONUS_PER_CHANNEL,
  computeConfidence,
  countCoveredQueryTokens,
  documentSatisfiesQuery,
  fuseCandidates,
  normalizeChannelScores,
  MORPH_MIN_PREFIX_LENGTH,
  SEARCH_CHANNEL_WEIGHTS,
  SEMANTIC_MEDIUM_FLOOR,
  HIGH_CONFIDENCE_SCORE_FLOOR,
  toCompatSearchMethod,
  tokenSetScore,
  type ChannelScores,
  type CompatSearchMethod,
  type FusedCandidate,
  type SearchChannelMethod,
  type SearchConfidence,
} from './search-fusion';
export {
  buildInformativeAnyMatch,
  hasInformativeQueryTerms,
  informativeSearchTokens,
  isInformativeQueryTerm,
  isNaturalLanguageRecall,
  queryWords,
} from './natural-search';
export {
  EmptySearchQueryError,
  EMPTY_SEARCH_QUERY_CODE,
  EMPTY_SEARCH_QUERY_MESSAGE,
} from './search-query-error';
export {
  canBypassLexicalAdmission,
  selectSemanticAdmittedIds,
  SEMANTIC_ADMISSION_FLOOR,
} from './semantic-admission';
export { generateUuid } from './uuid-helpers';
export { requireMemory, requireSpace, type MemoryRow } from './validation-helpers';
