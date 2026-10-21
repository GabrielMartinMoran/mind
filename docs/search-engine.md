# Search engine

Mind uses one relevance pipeline for every surface: CLI `search`, MCP
`memory_query(search)`, and `GET /api/search`. This page describes the current
behavior, the storage it depends on, and how to measure it. Read the
[search benchmark methodology](search-benchmarks.md) when you need to reproduce
a measurement.

## Pipeline at a glance

A query goes through four stages: parse, collect candidates, admit them, and
fuse the results. The pipeline is deterministic: the same database and query
produce the same order.

1. **Parse.** Quoted phrases, `OR`, `AND`, `NOT`, and a trailing `*` prefix are
   recognized. Adjacent terms are an implicit `AND`. Malformed operator usage
   degrades to a safe literal match and never raises an error.
2. **Collect candidates in parallel.** Lexical channels run phrase, all-term,
   and any-term relaxation rungs; a trigram channel handles substrings; a fuzzy
   channel handles close spellings; LIKE covers terms shorter than a trigram; a
   token-set channel scores partial multi-word coverage; and an optional
   semantic channel adds embedding neighbors.
3. **Admit candidates.** A coverage-based gate removes weak lexical matches.
   Semantic admission is independent for natural-language queries: a single
   group with no `NOT` and only plain terms may admit semantic-only candidates
   at cosine similarity 0.6 or higher. Explicit phrases, prefixes, and operators
   stay lexical.
4. **Fuse and rank.** Each channel is normalized and weighted, and an agreement
   bonus rewards candidates found by more than one channel. Every result carries
   a `score`, a `confidence` bucket (`high`, `medium`, or `low`), and a `methods`
   list of the channels that matched it.

`search_method` remains a compatibility summary (`fts5`, `like`, `trigram`,
`fuzzy`, `embeddings`, or `mixed`); `methods` is the per-result provenance.

## Storage and schema v10

Search reads two standalone FTS5 tables, both synced manually because
`bun:sqlite` cannot use FTS5 content-sync triggers with this schema:

- `memories_fts` uses the `porter unicode61` tokenizer for token, phrase, and
  fuzzy candidate work.
- `memories_fts_trigram` uses `trigram remove_diacritics 1` for substring
  matching on terms of three or more characters. Diacritic folding means
  accented and unaccented queries match each other.

Schema version 10 is the current and final consolidated schema. The trigram
table is contentless (`content=''`, `contentless_delete=1`), so it stores no
duplicate document text. FTS5's `rebuild` command is not available for it;
recovery uses delete-all plus repopulate. Both indexes are updated on add,
update, delete, space delete, and import through
`src/store/shared/fts-helpers.ts`.

## Fuzzy recall limit: prefix-3

The fuzzy channel generates candidates from the full folded document vocabulary
and scores them with a banded, early-exit optimal-string-alignment distance of
at most 2. Candidate generation requires a shared three-character prefix
(`FUZZY_PREFIX_LENGTH = 3`).

As a result, a typo inside the first three characters of a word is **not**
recoverable by the fuzzy channel. This is a deliberate cost/recall trade-off,
not a bug. The vocabulary is folded once per store and cached; every write bumps
a generation counter that invalidates the cache, so a search never reads a stale
vocabulary.

## Semantic recall

Semantic recall is optional and off by default. Enable RAG with `MIND_RAG=true`
and an embedding provider (`MIND_EMBEDDING_PROVIDER=openai` or `openrouter`).
Embeddings are stored in SQLite at 1536 dimensions, so switching providers keeps
existing vectors valid.

With RAG off, the semantic channel is omitted silently and lexical search is
unaffected. If a query-time embedding request fails, Mind opens an in-memory
breaker for about five minutes and skips the semantic channel instead of
retrying on every query.

## Performance envelope

Treat every latency and size number as host-specific. The durable signals are
ratios, storage bytes, and deterministic result hashes, not absolute
milliseconds from one machine. Low repetition counts make p95 and p99 noisy;
compare p50 and index size first.

Last measured envelope (maintainer host, 2026-10-17 fixture and synthetic
corpora; regenerate before quoting):

- The contentless trigram index is roughly 24 % smaller than the previous
  content-bearing trigram index, about 20 MB on the real corpus (about 4.5k
  memories).
- On the 50k synthetic corpus, the compact database is about 14 % smaller and
  the trigram index about 25 % smaller than the pre-optimization engine.
- Lexical search p50 on the real corpus stays in the tens of milliseconds. The
  fuzzy vocabulary is built once per store after a write; that cold-cache cost
  is per store, not per query.
- The 100k corpus number is a projection, not a measurement.

The full measurements, per-query methodology, and known limits live in
[search-benchmarks.md](search-benchmarks.md) and the frozen
[00004 optimization report](history/00004-search-optimization/search-optimization-report.md).
Do not copy an old absolute number into a current claim.

## Reproduce a measurement

The relevant tools are committed under `scripts/` and `test/`:

- `make search-eval` runs the deterministic relevance suite
  (`scripts/search-eval.ts`, fixtures in `test/search-eval/`). It needs no API
  key and is safe for local CI.
- `make bench-search` runs the fixture latency and size benchmark
  (`scripts/bench-search.ts`).
- `make bench-scalability CORPUS=1k|10k|50k|100k` runs the synthetic
  scalability benchmark. Heavy corpora require `--allow-heavy`.
- `make search-diff` compares two engine snapshots per query
  (`scripts/search-diff.ts`).

All benchmark stages are opt-in and stay outside `bun test` and CI. Only the
structural smoke test runs automatically.

## Tests that pin current behavior

- `test/query-parser.spec.ts` — grammar and AST.
- `test/search-fusion.spec.ts` — normalization, weights, confidence, admission.
- `test/trigram-search.spec.ts` — substring recall, diacritic folding, and
  contentless sync parity.
- `test/fuzzy-search.spec.ts` — vocabulary cache, banded OSA, prefix-3 limit.
- `test/search-consistency.spec.ts` — cross-surface ranking.
- `test/search-scenarios.spec.ts` and `test/search-eval.spec.ts` — taxonomy and
  snapshot/ranking gates.
- `test/search-diagnostics.spec.ts` — content-free diagnostics and byte
  equivalence.
- `test/search-bench-smoke.spec.ts` — structural smoke test of the benchmark
  output.

## Related documentation

- [Search benchmark methodology](search-benchmarks.md)
- [Documentation index](README.md)
- [Cognitive memory lifecycle](cognitive-memory-lifecycle.md) — why retrieval
  matters in the memory model
- [Search optimization history](history/00004-search-optimization/search-optimization-report.md)
