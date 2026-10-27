<!-- Owner: Mind maintainers | Updated: 2026-10-25 -->

# Search engine

Mind uses one relevance pipeline for every search surface: CLI `search`, MCP
`memory_query` with `search`, and `GET /api/search`. Checkpoint recovery also
calls it to gather context for a recovered checkpoint. This page describes the
current behavior end to end, the storage it depends on, and its known limits.
[Search benchmark methodology](search-benchmarks.md) owns measurement and
reproduction.

## Pipeline at a glance

Every search follows the same stages: validate the query, parse it, collect
candidates from independent channels, admit relevant candidates, fuse and score
them, then apply post-fusion filters and pagination. The shared store entry point
is `searchMemories` in `src/store/repositories/search-repository.ts`;
`MindStore.searchPage` adds the confidence filter and pagination on top.

1. **Validate.** A supplied query whose positive text contains no informative
   term after common stopwords are removed is a validation error, not an empty
   result. The check runs before any retrieval channel or embedding request.
2. **Parse.** The parser builds a query AST from quoted phrases, uppercase `OR`,
   `AND`, `NOT`, and a trailing `*` prefix. Adjacent terms are an implicit `AND`.
   Only the exact uppercase operator words are syntax; their lowercase forms are
   ordinary terms. Malformed operator usage degrades to a safe literal match and
   never raises an error.
3. **Collect candidates with a logical fan-out.** The lexical channels are
   logically independent: phrase, all-term, and any-term relaxation rungs; a
   trigram channel for substrings; a fuzzy channel for close spellings; LIKE for
   terms shorter than a trigram; a token-set channel for partial multi-word
   coverage (scored only over lexical candidates already collected); and an
   optional semantic channel for embedding neighbors. They run sequentially on
   one synchronous SQLite connection, so "fan-out" describes the candidate
   model, not concurrent execution.
4. **Admit candidates.** Explicit keyword, boolean, phrase, and prefix queries use
   a boolean-satisfaction gate with relaxed coverage and a lexical last-resort
   tier. Punctuated natural-language questions instead keep every informative
   lexical candidate so complementary partial matches can rank. Semantic
   admission is independent for natural-language queries: a single group with no
   `NOT` and only plain terms may admit semantic-only candidates at cosine
   similarity 0.6 or higher. Explicit phrases, prefixes, and operators stay
   lexical.
5. **Fuse and rank.** Each channel is normalized and weighted, an agreement bonus
   rewards candidates found by more than one channel, and results are ordered by
   fused score with deterministic tie-breaks.
6. **Shape, filter, and paginate.** Every result carries a `confidence` bucket
   (`high`, `medium`, or `low`); the pipeline also computes a `score` plus a
   `methods` list of the channels that matched it, which MCP returns only when
   the expanded-response flag is set. Confidence filtering, date filtering,
   totals, and pagination are applied after fusion and differ by surface.

## Query grammar and parsing

The parser in `src/store/shared/query-parser.ts` accepts a small, safe subset of
FTS5 syntax and never passes raw FTS5 input through.

- **Quoted phrases** match as a contiguous phrase.
- **`OR`** separates groups. Each group is an `AND` of its nodes.
- **`AND`** is optional; adjacent terms already mean `AND`.
- **`NOT`** excludes a following term, phrase, or prefix from every channel.
- **A trailing `*`** marks a prefix match on a term.

Operators are case-sensitive. Only uppercase `AND`, `OR`, and `NOT` are syntax;
lowercase `and`, `or`, and `not` are ordinary words. In a punctuated
natural-language question, the existing stopword filter removes lowercase `and`
and `or`, while lowercase `not` remains an ordinary term. The parser records
whether an explicit uppercase `AND` appeared so later policies can distinguish
intentional boolean syntax from a natural-language bag of words.

Malformed operator usage is a parser concern only: `parseQuery` never throws. An
unterminated quote, a dangling `NOT`, an `OR` with no left side, or a query with
no positive group degrades to a literal `AND` of the raw tokens, and the AST
records `degraded: true`. Search-level validation is a separate step that runs on
the resulting AST, so it still applies to a degraded query: a supplied search
whose positive text is only stopwords raises `EmptySearchQueryError` even when
the parser degraded the query.

The parser produces up to three lexical relaxation rungs: `phrase`, `all` (the
primary boolean expression), and `any` (one term must match). Duplicate `MATCH`
expressions collapse to the strongest first rung, so a single-term query yields
one rung.

## Supplied-query validation

Validation is separate from malformed-input fallback. Malformed operator usage
degrades without error, but a query that a caller deliberately supplies and that
has no informative terms is a caller mistake. The store throws one typed
`EmptySearchQueryError` before any candidate channel, admission pass, or semantic
embedding call.

The rule covers empty strings, whitespace, stopword-only text such as
`the and of`, and quoted stopword-only phrases such as `"the and of"`. It checks
positive query text with Unicode-aware word detection, so a supported non-Latin
script is not mistaken for an empty query. It never echoes the rejected raw
query. Every surface returns the same actionable message:

> Search has no informative terms after common words are removed. Add a specific
> topic, name, or identifier and try again.

Omission is different from an empty value. An omitted search field never enters
the pipeline:

- MCP `memory_query` without `search` stays in metadata-listing mode.
- `GET /api/search` without `q` keeps its HTTP 200 empty response.

A supplied field always enters search and can therefore raise the validation
error. Each surface translates the typed error in its own way:

- CLI `search` prints the message to stderr and exits with a failure status.
- MCP returns a tool error (`isError: true`) carrying the message.
- The HTTP API returns HTTP 400 with a JSON `{ "error": "..." }` body.
- Checkpoint recovery catches only this typed error and keeps its existing
  recent-memory fallback; unrelated failures still surface.
- The OmniMemEval bridge maps this typed error to HTTP 400 and leaves every other
  failure as a server error.

## Retrieval and scoring methods

Eight values can appear in a result's `methods` list. Seven are candidate
retrieval channels; `token_set` only scores lexical candidates that another
channel already retrieved, so it never adds a row to the result set.

| Method      | Kind         | What it contributes                                                                                 |
| ----------- | ------------ | --------------------------------------------------------------------------------------------------- |
| `phrase`    | Retrieval    | FTS `MATCH` for the quoted phrase rung.                                                             |
| `all`       | Retrieval    | FTS `MATCH` for the `all` rung: every node in a group must match, and `OR` groups are alternatives. |
| `any`       | Retrieval    | Relaxed rung where at least one query term matches.                                                 |
| `trigram`   | Retrieval    | Substring `MATCH` on query terms of three or more characters.                                       |
| `fuzzy`     | Retrieval    | Banded OSA distance of at most 2 over the folded document vocabulary.                               |
| `like`      | Retrieval    | `LIKE` scan for terms shorter than three characters.                                                |
| `semantic`  | Retrieval    | Cosine neighbors from stored embeddings when RAG is enabled.                                        |
| `token_set` | Scoring only | Fraction of distinct query tokens present in a lexical candidate.                                   |

The `any` rung applies a coverage filter when the query is a single group with at
least two tokens, and the `trigram` and `fuzzy` channels always apply one, so a
single weak token cannot pull in an unrelated document. `trigram` skips terms
shorter than three characters, and `like` handles exactly those short terms.
`fuzzy` caps its query expansions (`FUZZY_MAX_EXPANSIONS = 50`) and is described
in [Fuzzy recall limit: prefix-3](#fuzzy-recall-limit-prefix-3). Each result's
`methods` list uses a fixed order: `phrase`, `all`, `any`, `semantic`, `trigram`,
`fuzzy`, `like`, `token_set`.

`NOT` exclusions are resolved first with an FTS `MATCH` and applied to every
channel, including trigram, fuzzy, and semantic, which do not carry the `NOT`
clause in their own queries.

## Admission

Admission decides which collected candidates become results. It runs on the
lexical candidate view; semantic rows are excluded from this view so they cannot
change lexical admission or the token-set score.

### Explicit and keyword queries

Strict behavior applies to unpunctuated keyword searches and to any query that
uses explicit boolean, phrase, or prefix syntax. It keeps candidates in tiers:

1. **Strict boolean satisfaction.** A candidate is kept when it satisfies at
   least one `OR` group, with every node in that group matching. Matching folds
   case and accents. A phrase matches as a substring; a prefix matches a word
   start; a plain term matches when the folded text contains it, or when a word
   shares an inflection-tolerant prefix of at least four characters
   (`MORPH_MIN_PREFIX_LENGTH = 4`).
2. **Relaxed coverage.** Only when strict admission keeps nothing and the query
   has at least two tokens, candidates covering at least
   `max(2, floor(tokenCount / 2))` distinct query tokens are admitted.
3. **Lexical last resort.** Only when the relaxed tier still keeps nothing, every
   lexical channel candidate is admitted. Semantic candidates never enter here.

### Natural-language questions

A punctuated question (`?` or `¿`) with one plain-term group, no `NOT` exclusion,
and no explicit uppercase `AND` uses broad recall instead of the strict ladder.
Common English and Spanish function words cannot seed a candidate, the any-rung
is built from the informative terms, and the coverage filter is skipped. Every
informative lexical candidate stays in the result set so fusion ranks
complementary partial matches alongside exact ones; a partial match is no longer
discarded just because an exact match exists.

### Independent semantic admission

Semantic candidates are considered separately, after the lexical ladder. The
bypass applies only when the query has exactly one positive group, no `NOT`
exclusions, every node is a plain non-prefix term, and no explicit uppercase
`AND` appeared (`canBypassLexicalAdmission`). Those are the natural-language
bag-of-words shapes: implicit `AND` qualifies. An explicit uppercase `AND`
disqualifies the query even though the parser folds its terms into one group,
because it signals intentional boolean syntax. An `OR` creates multiple groups,
while quoted phrases, prefixes, and `NOT` each disqualify the query. For a
qualifying query, a semantic candidate is admitted when its cosine similarity is
at least `0.6` (`SEMANTIC_ADMISSION_FLOOR`). This bypass works even when lexical
admission already succeeded, so it can add semantically paraphrased rows.

For an `OR`, phrase, prefix, `NOT`, or explicit-`AND` query, semantic candidates
cannot add rows. They can still contribute their channel score and `methods`
value to a row that lexical admission already kept. Semantic retrieval itself
runs only when RAG is enabled, the request allows it, and the breaker is closed.
It uses a permissive cosine floor of `0.3` and at most 50 candidates
(`SEMANTIC_TOP_K`) after the space, tag, and tier filters. Those scores feed
fusion for rows lexical admission kept; the `0.6` floor governs whether a
semantic-only candidate can add a new row.

## Fusion, scores, and confidence

Fusion combines the per-channel scores of admitted candidates. Each channel is
min-max normalized per query: an empty channel is absent, and a channel whose
scores are all equal gives every candidate `1.0` so it contributes its full
weight. The fused score is the weighted sum plus an agreement bonus of `0.05`
per extra matching channel, capped at `0.15`.

These weights are current tuning, not a stable API guarantee:

| Channel     | Weight |
| ----------- | ------ |
| `phrase`    | 1.0    |
| `all`       | 0.9    |
| `semantic`  | 0.8    |
| `trigram`   | 0.6    |
| `any`       | 0.55   |
| `like`      | 0.5    |
| `fuzzy`     | 0.4    |
| `token_set` | 0.3    |

Results are ordered by fused score descending, then memory name ascending, then
memory id ascending. A result's `score` is its fused score divided by the best
fused score in the same query, so the top result is `1.0`. It is a relative
signal within one query and is not comparable across queries.

Ordering is deterministic for the same database, query, and semantic inputs.
Two runs can differ when an external embedding provider returns different
vectors or when the semantic breaker changes whether the semantic channel runs,
because those inputs change the candidate set.

The `confidence` value is a three-level bucket, not a calibrated probability:

- `high`: matched by `phrase` or `all` with a relative score of at least `0.6`.
- `medium`: matched by `phrase` or `all` below that floor, by `any`, `trigram`,
  `like`, or `token_set`, or by `semantic` at cosine `0.6` or higher without a
  strong or medium lexical channel.
- `low`: otherwise, typically `fuzzy` only or `semantic` below cosine `0.6`
  without a stronger channel.

`methods` is the per-result provenance list described above. `search_method` is
different: it is an MCP-only compatibility field, projected from the top-ranked
result's `methods` into `fts5`, `like`, `trigram`, `fuzzy`, `embeddings`, or
`mixed`. It is not part of each result and the CLI and HTTP API do not send it.

## Result fields and surface differences

All surfaces share the same fused ranking, and the store returns `score`,
`confidence`, and `methods` on every result. How much of that each surface
exposes, and how it filters and paginates, differs.

- **CLI `search`.** Supports `--space` (`*` means all), `--tag`, `--tier`,
  `--detail`, `--limit` (default 25, capped at 500), and `--offset`. It fetches
  the full ranked set, reports the full admitted count, and slices locally. It
  has no `confidence` or `semantic` filter.
- **MCP `memory_query`.** Requires `space` (`*` means all) and accepts `search`,
  `tag`, `tier`, `from`/`to`, `limit` (default 25, maximum 500), and `offset`.
  Omitting `search` lists memories by metadata; supplying it, even as an empty
  string, runs search and can raise the validation error. The `from`/`to` date
  range filters on `changed_at` after fusion, so `total` reflects the post-date
  count. By default each result keeps `confidence` alongside the memory fields,
  and it adds `score`, `methods`, and the top-result-based `search_method` only
  in expanded debug mode (see below). The semantic channel follows the
  server's RAG setting.
- **HTTP `GET /api/search`.** Accepts `q`, `space` (`*` means all), `tag`,
  `tier` or `tiers`, `confidence`, `semantic` (`on`/`off`), `limit` (default 25,
  maximum 500), and `offset`. Without `q` it returns HTTP 200 with an empty
  result set; a supplied `q` with no informative terms returns HTTP 400.
  `confidence` filters after fusion, and `semantic` explicitly skips or allows
  the semantic channel for that request. `total` is the admitted count after the
  confidence filter and before pagination, exposed as `X-Total-Count`;
  `X-Has-More` compares the next offset with it.
- **Checkpoint recovery.** Builds a query from the checkpoint content, calls the
  same search in the checkpoint's space, and keeps up to five non-checkpoint
  hits as context. If the generated query has no informative terms, the typed
  validation error triggers the existing recent-memory fallback.

The engine paginates only when a caller supplies `limit` or `offset`, clamping
`limit` to `[1, 500]` and `offset` to `>= 0` (`paginateSearchResults` in
`src/store/sqlite-store.ts`). The default of 25 belongs to the CLI, MCP, and API
surfaces, not to the store. For browser behavior and URL state, see
[Web UI](web-ui.md).

## Response fields by surface

CLI `search` prints its existing result lines, including the `confidence`
bucket. `GET /api/search` keeps `score`, `confidence`, and `methods` on every
result item. MCP `memory_query(search)` is compact by default: each result keeps
`confidence`, `changed_at`, and the other memory fields, while `score` and
`methods` are omitted and the top-level `search_method` is absent.

MCP includes those three diagnostic fields only when the Mind MCP process runs
with `USE_DEBUGGING_EXPANDED_TOOLS_RESPONSE` set to exactly `true`. The variable
is read by Mind, not by the agent client. With the flag unset or set to any other
value (`false`, `1`, `TRUE`), the response stays compact. `total`, `limit`,
`offset`, and result order are the same in both modes, and `search_method`
stays absent when a search returns no hits. The YAML text item and
`structuredContent` always carry the same fields.

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
and scores them with a banded, early-exit optimal-string-alignment distance of at
most 2. The vocabulary scan is gated on a minimum token length of
`FUZZY_PREFIX_LENGTH = 3`. A query token of three or more characters produces
candidates only from vocabulary words that share its first three characters. A
query token shorter than three characters produces no fuzzy expansions at all,
so it relies on the lexical channels instead.

As a result, for a query token of three or more characters, a typo inside its
first three characters is **not** recoverable by the fuzzy channel. This is a
deliberate cost/recall trade-off, not a bug. The v2 relevance suite measured
first-three-character recall at **8.3 % (1/12)**. A prefix-free scan would
recover those typos but does not scale; the deferred alternatives are listed in
[Known limits and deferred options](#known-limits-and-deferred-options).

The vocabulary is folded once per store and cached. The cache key combines the
local write generation with SQLite's `PRAGMA data_version`, so a write from
another connection or process also invalidates it. A search never reads a stale
vocabulary.

## Semantic recall (RAG only)

Semantic recall is optional and off by default. Enable RAG with `MIND_RAG=true`
and an embedding provider key. `MIND_EMBEDDING_PROVIDER` selects `openai` (the
default, using `OPENAI_API_KEY` and `text-embedding-3-small`) or `openrouter`
(using `OPENROUTER_API_KEY` and `openai/text-embedding-3-small`). An invalid
provider value disables RAG; there is no fallback provider.

Both provider models currently produce 1536-dimension vectors, which is why
switching providers keeps stored vectors usable. The schema stores embeddings as
a plain `BLOB` and does not enforce a dimension invariant, so a future model with
a different size would require re-embedding rather than a schema guarantee.

With RAG off, the semantic channel is omitted silently and lexical search is
unaffected. With RAG on, a query-time embedding failure opens an in-memory
breaker for about five minutes (`SEMANTIC_BREAKER_TTL_MS`) and later queries skip
the semantic channel instead of retrying on every query.

Semantic recall carries a real cost. In a LoCoMo-based investigation, enabling
RAG moved p50 latency from **14.3 ms to 767.8 ms (53.8×)** for **+5.6 pp** of
full evidence@10, with 0 gold items displaced. Those numbers come from one
corpus on one host; treat them as a caution about the cost/benefit trade-off,
not as a general performance guarantee. Keep RAG off for interactive use unless
you have measured the trade-off for your own corpus.

## Search diagnostics

Set `MIND_SEARCH_DIAG=1` to emit one JSON line per search to stderr. The payload
contains per-channel timings and candidate counts, fuzzy expansion and cache
state, total candidates and milliseconds, and admission counts (kept, dropped,
and semantically admitted). It never contains memory content, memory names, or
query text, and enabling it does not change results or ordering.

## Known limits and deferred options

Current behavior is bounded by several documented limits. These are not
promises of future work; they explain why some obvious alternatives are not in
the engine.

- **Unbounded full-content SQL at scale.** The lexical rungs run `MATCH`
  without a `LIMIT` and fetch `content` before the coverage filter runs in
  JavaScript. On a **synthetic 100k prototype corpus**, one `long_nl` query
  fetched **271,263 rows** and kept **2,934**. That 100k result is synthetic
  prototype evidence, not a production measurement.
- **Provenance-blind admission.** The strict admission predicate evaluates the
  folded document text but does not receive fuzzy expansions. A term corrected
  only by the fuzzy channel can therefore fail strict admission, and a substring
  host can suppress the relaxed fallback. Broad natural-question recall skips
  this predicate, so it is not exposed to the same loss.
- **Rejected P-D dictionary.** A per-document term dictionary would recover
  prefix-free typos, but at 50k it added about **255 MB** to the database and
  ran slower than the current engine, so it was rejected.
- **Rejected `detail=none`.** The smaller trigram variant breaks queries longer
  than three characters and requires a JavaScript post-check with 5–8 % false
  positives. The complexity is not justified.
- **Deferred prefix-free term trigram.** A trigram index over unique terms
  restored first-three recall in prototypes but needs a short-token fallback and
  an invalidation design before it could replace the current scan.
- **Deferred `d1short` and anchor guards.** Length-dependent distance and a
  literal anchor reduced function-word noise in prototypes, but they are not
  part of the current channel.

`searchFallback` is a legacy helper that still exists in the store, but no
production search surface calls it. Do not confuse it with the pipeline on this
page.

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

The full measurements, per-query methodology, command reference, and known
limits live in [search-benchmarks.md](search-benchmarks.md) and the frozen
[00004 optimization report](history/00004-search-optimization/search-optimization-report.md).
Do not copy an old absolute number into a current claim.

## Tests that pin current behavior

The current pipeline is covered at unit, integration, and contract level; no E2E
test is needed for this behavior because the surfaces share one store pipeline.

- `test/query-parser.spec.ts` — grammar, AST, and case-sensitive operator
  provenance.
- `test/search-fusion.spec.ts` — normalization, weights, confidence, admission.
- `test/search-natural-recall.spec.ts` — informative-term recall, supplied-query
  validation, and candidate retention.
- `test/search-semantic-admission.spec.ts` — semantic bypass eligibility,
  including explicit-`AND` disqualification.
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
- [Web UI](web-ui.md) — search filters and URL state in the browser
- [Documentation index](README.md)
- [Cognitive memory lifecycle](cognitive-memory-lifecycle.md) — why retrieval
  matters in the memory model
- [Search optimization history](history/00004-search-optimization/search-optimization-report.md)
