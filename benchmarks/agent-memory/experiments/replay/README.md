# E-WB replay workbench

Reproduces a benchmark run's exact Mind retrieval, off-line and for free, from a
copy of a pinned worktree's database. It is the foundation for the false-negative
classification (E-WB2) and for any later query-strategy experiments.

## Why

The original runs (`run-mind-20261019`, `run-mind-rag-20261019`) were produced by
the Python `agent-memory-bench` harness driving `mind serve` over HTTP. To analyse
_where_ recall was lost we need to re-run the same 120 queries against the same
stored database, with the pipeline instrumented, without touching the original
DBs and without paying for anything.

## What it does

`replay.ts`:

1. copies the source SQLite DB (plus WAL/SHM sidecars) into an isolated scratch
   dir under `.work/experiments/replay-scratch/`;
2. starts `<worktree>/mind serve start --port <free>` in its own process group,
   on a non-reserved loopback port, with an isolated `MIND_*` env and RAG off;
3. polls `/api/search` until ready, then runs every `kind:"probe"` record from
   `probes.jsonl` through
   `GET /api/search?q=<question>&space=<space>&limit=<limit>`;
4. records the ranked names, contents, score/confidence/methods and client
   latency per probe to a JSON file;
5. stops the server (whole process group) in a `finally` block.

`--debug-sink <path>` additionally sets `MIND_SEARCH_DEBUG`, so an instrumented
worktree appends one JSONL record per query (see
`../instrumentation/README.md`). The file is truncated after the readiness probe
so it holds exactly the probes.

## Faithful reproduction

The mapping from `membench/adapters/mind_adapter.py`:

- space is `locomo/membench`;
- the run recorded `context_chunks` with `top_k=10`, counting non-blank content
  chunks capped at 10. So the validation gate uses `--limit 10`. (The task text
  said `limit=25`; that cannot reproduce the stored counts because 94/120 probes
  are capped at exactly 10. `--limit` is configurable; `validate.ts` also runs an
  instrumented `limit=25` pass to produce the E-WB2 dumps.)

## Run

```bash
bun run experiments/replay/replay.ts \
  --worktree .work/worktrees/v10 \
  --db .work/integrations/agent-memory-bench/mind-scratch/run-mind-20261019-mind-conv-26/mind.db \
  --probes .work/integrations/agent-memory-bench/results/run-mind-20261019/probes.jsonl \
  --out .work/experiments/replay-scratch/my-run.json \
  --limit 10
```

## Validate (E-WB1 gate)

```bash
bun run experiments/replay/validate.ts
```

Runs the plain replay twice (determinism), the instrumented replay once
(`admitted_ranked_final` == plain), and an instrumented `limit=25` pass whose
debug JSONL becomes the E-WB2 input. Evidence is written to
`experiments/REPORTS/workbench/validation-rag-off.json`; exit code is non-zero if
any gate fails.
