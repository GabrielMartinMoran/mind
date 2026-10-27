// ── Search evaluation suite barrel ──

export * from './types';
export { normalizeText, tokenizeWords, deriveExpected, classifyPresence } from './ground-truth';
export type { CorpusDoc, MatchSpec } from './ground-truth';
export { refOf, parseRef, dedupeRefs, sortRefs } from './refs';
export { stableStringify, stableHash } from './hash';
export {
  DEFAULT_K,
  resolveK,
  computeVerdict,
  aggregateVerdicts,
  aggregateBy,
  type CaseVerdict,
  type SegmentMetrics,
} from './metrics';
export { FIXTURE_CORPUS, FIXTURE_SPACES, listFixtureSpaces } from './corpus';
export { buildFixtureCases } from './cases';
export {
  runSuite,
  buildSnapshot,
  seedFixtureStore,
  runFixture,
  runReal,
  type SearchFn,
  type CaseReport,
  type RunReport,
  type FixtureSnapshot,
  type RealRunReport,
  type RealCaseResult,
} from './evaluator';
export { CURATED_REAL_QUERIES, scanTokens, buildRealCasesFile } from './real-cases';
export { renderSummaryTable, renderRealSummary } from './report';
