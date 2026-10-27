# E-WB instrumentation (test-only)

Minimal, observational instrumentation of Mind's search pipeline used by the
E-WB replay workbench. **It never ships to production.** The patch
(`search-debug.patch`) is applied only to a throwaway copy of the pinned v10
worktree (`.work/experiments/instrumented-v10`); the repository's `src/` is
untouched and `git status -- src test web` stays empty.

## What it adds

All additions are side channels: they read result-affecting state and write a
separate file / emit diagnostics. They do **not** change candidates, admission,
fusion, ordering, or the public API. Validation (`REPORTS/workbench/`) proves the
instrumented `admitted_ranked_final` equals the plain replay's ranked results.

1. **Zero-reason on every return.** `searchMemories` now emits diagnostics even
   on the paths that previously returned silently:
   - `empty_query` — query parses to an empty AST (`:641` in the original).
   - `no_rungs` — the parser produced no relaxation rungs (`:644`).
   - `no_candidates` — no channel produced a candidate, or everything was
     dropped before admission (`:837`, `:870`).
   - `null` — the call returned a ranked result set.

2. **Per-rung pre/post coverage counts.** For `any`, `trigram`, and `fuzzy`
   (plus `phrase`/`all`, which are not coverage-filtered and therefore report
   `raw == after_coverage`), diagnostics now carry
   `coverage: [{ channel, raw, after_coverage }]`. This exposes the
   `max(2, floor(n/2))` coverage floor that was previously invisible.

3. **Admission breakdown.** `admission` gains `excluded_by_not`,
   `dropped_by_predicate`, and `admission_tier: 'strict' | 'relaxed' |
'last_resort'`, so the internal relaxation ladder is observable.

4. **ID-level debug sink (env-gated).** Setting `MIND_SEARCH_DEBUG=<path>` makes
   every `searchMemories` call append one JSONL line with ordered **memory
   names** at each stage. Unset (production), it costs one `process.env` read.

5. **E-WB2 un-capping + explicit NOT set.** `admitted_ranked_final` is emitted up
   to `DEBUG_RANK_CAP = 1000` (was 50), every record carries `excluded_by_not`
   names and `admission_kept`/`admission_dropped` totals, so a ranked item can
   never be ambiguous between "dropped by admission" and "admitted beyond the
   cap". The E-WB1 validation gate was re-run after this change and stayed PASS.

## Debug JSONL schema (one line per query)

```jsonc
{
  "q": "What does Melanie do ...",              // query string (public LoCoMo question)
  "candidates_by_channel": {                    // ordered names per channel (channel rank order)
    "all": ["D1:1", "D2:3"], "any": [...], "trigram": [...], "fuzzy": [...],
    "like": [...], "semantic": [...], "token_set": [...]
  },
  "after_coverage_by_rung": {                   // same channels after the coverage floor
    "phrase": [...], "all": [...], "any": [...], "trigram": [...], "fuzzy": [...]
  },
  "after_not": ["D1:1"],                        // after NOT exclusions
  "excluded_by_not": ["D3:4"],                  // explicit NOT-excluded names
  "admitted_strict": ["D1:1"],                  // strict boolean predicate, before relaxation
  "admitted_ranked_final": ["D1:1", "D2:3"],    // final fused rank order, up to DEBUG_RANK_CAP=1000
  "admission_kept": 2,                          // total admitted (before the rank cap)
  "admission_dropped": 1,                       // candidates removed by the admission gate
  "zero_reason": null,                          // 'empty_query' | 'no_rungs' | 'no_candidates' | null
  "admission_tier": "strict"                    // 'strict' | 'relaxed' | 'last_resort'
}
```

IDs are emitted as **memory names** (the benchmark names each turn by its
`dia_id`). This is safe because it is a throwaway scratch copy of a public
benchmark database; no user data is involved.

## Apply the patch

```bash
cp -a benchmarks/agent-memory/.work/worktrees/v10 <dest>
rm -f <dest>/.git
patch -d <dest> -p1 < benchmarks/agent-memory/experiments/instrumentation/search-debug.patch
```

The patch was generated with `diff -u` against `worktrees/v10` @ `c7029b3` and
verified with `patch -p1 --dry-run`.
