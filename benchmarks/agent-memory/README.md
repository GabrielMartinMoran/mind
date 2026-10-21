# Agent memory benchmark

A small, automated, repeatable harness that measures whether
[Mind](../../) helps a real [OpenCode](https://opencode.ai) agent remember and
use information — not just lexical similarity.

> Mind under an external harness: a Mind row next to Mem0 / LangMem / Zep and
> others on the [agent-memory-bench](https://github.com/hamza-dev-tech/agent-memory-bench)
> protocol — see [`integrations/agent-memory-bench/COMPARISON.md`](integrations/agent-memory-bench/COMPARISON.md).
>
> For the cross-block handoff analysis (measured facts, gaps and prioritized
> experiments), see [`ANALYSIS.md`](ANALYSIS.md).

It compares three conditions on the same model, tools and prompts:

| Condition   | Memory                                                              |
| ----------- | ------------------------------------------------------------------- |
| `no-memory` | none (baseline)                                                     |
| `mind-v9`   | Mind at `main@36d2f1e` (schema 8, pre-multichannel engine)          |
| `mind-v10`  | Mind at `develop@c7029b3` (schema 10, multichannel search pipeline) |

`v9`/`v10` are the user's branch labels; the report records the real schema
versions (8 and 10) to avoid confusion. Each version runs its **own** code from
a pinned git worktree.

## What it measures

- **A — LoCoMo** (deterministic subset, conversation `conv-26`):
  - **A1 retrieval** (no LLM): Recall@5/@10, MRR, precision, latency, context
    tokens.
  - **A2 answering** (real OpenCode): correct / partial / incorrect /
    abstention / hallucination, memory calls, tokens and cost, latency.
- **B — agent scenarios**: 8 small scenarios (architectural decision, known
  bug, decision change, sub-agent transfer, distributed information, absent
  information, tier maintenance, semantic recall). Evaluated by tests/assertions,
  never by the agent's prose.

A and B are always reported separately.

## Requirements

- [Bun](https://bun.sh) (repo uses Bun 1.3.x).
- Install the harness's own dependencies once:
  `cd benchmarks/agent-memory && bun install`. The subproject owns its
  `package.json`, `bun.lock`, and `tsconfig.json`; the root `bun install` does
  not install benchmark dependencies.
- A real OpenCode install (`opencode --version`; the harness is verified against
  **2.0.28**). The pinned SDK (`@opencode/sdk@2.0.28`) is a dependency of this
  benchmark subproject, not of the root package.
- For paid stages: a valid **OpenRouter** credential for the pilot model
  **`deepseek/deepseek-v4.1-flash`**. The harness reads the key at runtime from
  `~/.local/share/opencode/auth.json` (provider `openrouter`) into the child
  process environment only (`OPENROUTER_API_KEY`); it is never printed or
  written to artifacts. (The `opencode-go` pairing remains available as an
  alternative constant but is paused.)
- Free stages (probes, unit tests) need none of the above.

## Isolation (fail-closed)

Every condition runs in its own temporary tree under
`benchmarks/agent-memory/runs/<run-id>/<condition>/`:

- a private `HOME` and `XDG_{CONFIG,DATA,STATE,CACHE}_HOME`, so OpenCode never
  reads user config/plugins/skills, never reuses the shared background service,
  and keeps its own session database (`OPENCODE_DB`);
- `OPENCODE_CONFIG_CONTENT` pinning exactly the authorized model
  (`openrouter/deepseek/deepseek-v4.1-flash`) and, for Mind conditions, exactly one local
  `mind` MCP server; `no-memory` gets zero MCP;
- the `OPENCODE_DISABLE_*` guards (project config, Claude Code, default plugins,
  model fetch, autocompact);
- a fresh Mind database per condition/scenario
  (`MIND_DB_PATH`/`MIND_DATA_DIR`/`MIND_SYNC_ROOT` under the run dir,
  `MIND_RAG=false`). The user's live `data/mind.db` is never opened.

Before any paid prompt, `verifyIsolation` checks the effective paths, config,
MCP list, session list and agents/skills/commands/plugins. A single failure
throws and the run is **rejected** (raw dumps saved as evidence).

Two OpenCode 2.0.28 mechanics are handled explicitly: the `mcp list` check
retries a bounded number of times because the managed background service loads
MCP config asynchronously after boot (the first call can report "No MCP servers
configured" while the server connects moments later), and the SDK host is handed
the inline config directly (`config.content`) because — unlike the CLI — the
in-process host does not read `OPENCODE_CONFIG_CONTENT` on its own. MCP tools are
invoked through the code-mode `execute` tool, so the driver unwraps
`state.metadata.toolCalls` / `state.input.code` to count real `mind.*` calls.

Credential env values are redacted at write time: worker `job.json` files (and the
raw A2 result dump) never contain a provider key; the real value reaches the child
only through its spawn environment.

## Budget policy

Paid stages require an explicit `--budget <usd>` cap and refuse to run without
it. A run aborts immediately when the cap would be crossed.

| Stage    | Cap                |
| -------- | ------------------ |
| smoke    | ≤ $0.05            |
| pilot    | $5 (approved)      |
| full run | not yet authorized |

## Commands

Everything below runs from the subproject directory. From the repository root,
prefix with `cd benchmarks/agent-memory &&`, or use the `make` convenience
targets (they delegate into the subproject).

```sh
cd benchmarks/agent-memory && bun install

# Unit + contract tests (fast; integration skipped)
bun test test
bun run test:experiments

# Integration tests (reuses/creates pinned worktrees; no LLM)
BENCH_INTEGRATION=1 bun test test

# Free OpenCode skill-first discovery test (no LLM; skipped without opencode)
BENCH_INTEGRATION=1 bun test test/skill-discovery.integration.spec.ts

# Free T1 platform/isolation probes (no LLM calls)
bun run probe

# Harness CLI (all flags: bun run cli --help)
bun run cli probe
bun run cli clean           # remove run dirs
bun run cli clean --all      # + prepared worktrees

# Free LoCoMo A1 retrieval run (no LLM, no --budget): downloads the dataset
# (sha256-pinned), ingests conv-26 into both pinned engines and scores retrieval.
bun run cli locomo --subset pilot --conditions mind-v9,mind-v10   # 5 questions
bun run cli locomo --subset full --conditions mind-v9,mind-v10    # 30 questions

# Paid LoCoMo A2 answering + judge (require an existing free run + budget/confirm)
bun run cli locomo --answers --run-id <id> --budget 5 --confirm
bun run cli locomo --judge-only --run-id <id> --budget 5 --confirm

# Paid credential smoke (ONE minimal prompt; reads the key at runtime, writes
# sanitized evidence to probes/evidence/openrouter-smoke.json)
bun run smoke

# Full orchestration: free A1 always; paid A2+scenarios only with BUDGET; then REPORT
bun run full                       # free A1 + REPORT only
bun run full --budget 5 --confirm  # + paid A2 + scenarios + REPORT
```

From the repository root, the same flows via Makefile convenience targets:

```sh
make bench-agent-memory-test
make bench-agent-memory-probe
make bench-agent-memory-locomo                 # SUBSET=pilot (default)
make bench-agent-memory-locomo SUBSET=full
make bench-agent-memory-full                       # free A1 + REPORT only
make bench-agent-memory-full BUDGET=5 CONFIRM=1    # + paid A2 + scenarios + REPORT
make bench-agent-memory-report RUN=<run-id>        # default benchmarks/agent-memory/REPORT.md
make bench-agent-memory-report RUN=<run-id> OUT=path/to/REPORT.md
```

### Pilot run (T7b) — `mind-v10` only

The reduced pilot runs a **single condition** (`mind-v10`, i.e. `develop`), with
no `no-memory`/`mind-v9` baselines and no benchmark-B scenarios. Run the three
stages in order; pick a `RUN_ID` (or omit `--run-id` on stage 1 to generate one
and reuse the printed id).

```sh
# Stage 1 (FREE): worktrees + dataset + ingest + A1 retrieval for mind-v10 only
bun run cli locomo \
  --subset pilot --conditions mind-v10 --run-id <RUN_ID>

# Stage 2 (PAID, cap $5): A2 answering + blind judge for mind-v10 only
bun run cli locomo --answers \
  --run-id <RUN_ID> --conditions mind-v10 --budget 5 --confirm

# Stage 3 (FREE): REPORT.md from the run artifacts
bun run cli report --run-id <RUN_ID>
```

Artifacts: `benchmarks/agent-memory/runs/<RUN_ID>/{meta.json,subset.json,results/}`,
the ingested DB at `runs/<RUN_ID>/mind-v10/mind.db`, and
`benchmarks/agent-memory/REPORT.md`.

> The `make bench-agent-memory-locomo` / `bench-agent-memory-full` targets are
> wired for the full multi-condition run and are **not** the T7b path; use the
> staged CLI commands above for the `mind-v10`-only pilot.

Paid benchmark B scenarios (require an explicit `--budget` + `--confirm`):

```sh
bun run cli scenarios \
  --scenarios b1,b4,b5,b6,b7,b8,b9,b10,b11 --conditions no-memory,mind-v9,mind-v10 --budget 5 --confirm
# or, from the repo root: make bench-agent-memory-scenarios SCENARIOS=b1,b4,b5,b6,b7,b8,b9,b10,b11
# B5/B6/B7/B8/B9 need a Mind engine; under no-memory they are reported as not_run.
# B10 also needs RAG + an embedding credential; otherwise it is not_run, never failed.
```

## LoCoMo A1 (free)

`locomo` runs the free half of benchmark A end-to-end:

1. prepare the pinned `v9`/`v10` worktrees (`git worktree add` + `bun install`);
2. download LoCoMo (`https://github.com/snap-research/locomo`, **CC BY-NC 4.0**)
   into `.work/dataset/` (gitignored) and verify/pin its sha256;
3. select a deterministic subset of `conv-26` (pilot = 1 per category = 5;
   full = 6 per category = 30; seeded `mulberry32`, default seed `20261018`);
4. per engine: create `locomo/conv-26`, ingest one T3 memory per turn
   (`name = dia_id`, `content = "[<date_time>] <speaker>: <text>"`, tags
   `locomo` + `session:<n>`), verify count == turns and name-set == dia_id set,
   then score A1 retrieval through `GET /api/search` (top-25).

Metrics: hit@5/@10, evidenceRecall@10, MRR, precision@10, context tokens
(`ceil(chars/4)`), latency p50; aggregated per category with categories 1–4
pooled and category 5 (adversarial) reported separately. The dataset is never
committed; per-run artifacts (`subset.json`, `results/*.json`, `meta.json`)
live under `runs/<run-id>/` (gitignored).

## LoCoMo A2 (paid; requires `--budget --confirm`)

`locomo --answers --run-id <id>` extends a prepared free run with the paid
answering + blind-judge stages; `locomo --judge-only --run-id <id>` re-judges
stored answers without re-answering. Both refuse to run without an explicit
`--budget` cap and `--confirm`.

- **One prompt, one condition.** Every (condition × question) runs as its OWN
  child process with a fresh isolated environment and its own session; the
  prompt template is a single condition-independent constant that never
  mentions memory, Mind or any engine, and instructs one canonical abstention
  sentence.
- **Per-question database copies.** Each Mind measurement starts from a
  byte-identical copy of the ingested condition database (WAL folded, main +
  `-wal`/`-shm` copied), so no question can pollute a later one.
- **Deterministic primary scoring.** Normalized token-F1 against the reference
  for categories 1–4 (our fixed protocol, no Porter stemming), and
  abstention/hallucination scoring for category 5 (adversarial).
- **Blind LLM judge (secondary).** One payload per question with the question,
  the reference and all candidate answers ANONYMIZED and order-randomized
  (seeded). The condition→label mapping is kept OUT of the payload; verdicts are
  mapped back through the stored order. Unparseable responses get one repair
  attempt, then go to a manual queue. Only `agents/skills/commands/plugins` and
  session leaks are checked for the judge, which runs with all tools denied.
- **Judge bias limitation.** The judge runs on the same model family as the
  measured agent, so it can share that model's blind spots; judge scores are
  reported alongside — never instead of — the deterministic scores.
- Stage statuses (`a2:<condition>`, `judge:start`) and actual spend are recorded
  in `meta.json`.

## Benchmark B — agent scenarios (paid; requires `--budget --confirm`)

`scenarios` runs small, self-contained agent tasks with a production session and
a need session, then evaluates them with concrete assertions over the workspace
or the unit's Mind database — never by the agent's prose. Nine scenarios ship
today:

- **B1 — persistent architectural decision.** Session 1 analyses the fixture
  (`taskboard/`) and decides how persistence must be implemented (Bun only, no
  new dependencies/native binaries; files under `data/`; UTC ISO-8601
  timestamps), preserving the decision for later. Session 2 implements the
  `export` command. The assertion checks the constraint set landed: no new
  dependencies, a JSON/JSONL file under `data/`, UTC ISO-8601 timestamps, and
  that `bun run export` succeeds. It requires **at least one** UTC ISO-8601
  timestamp to be present in the persisted data (a documented constraint, not a
  count).
- **B4 — sub-agent transfer.** Session 1 investigates a failing test and reports
  the root cause + fix strategy. Session 2 explicitly delegates the fix to a
  sub-agent. The assertion checks the test suite passes and that a child session
  was created; whether the child used memory tools is measured, not required.
- **B5 — durable writing.** Session 1 makes a constrained persistence decision
  and must preserve it for later; session 2 applies it and writes `applied.txt`.
  The assertion reads the unit database: a project-space memory tagged
  `cat:decision` or `cat:pattern` must contain the decision's key terms, no
  duplicate name may exist, and `applied.txt` must reflect the stored decision.
- **B6 — relinking.** Two seeded memories (a strategy and its implementation)
  start with a stale `related` link. Session 1 corrects the relationship;
  session 2 uses it and writes the answer to `answer.txt`. The assertion checks
  the stored direction/label (`checkout-implementation → checkout-strategy
[implements]`), that `related` is gone, and that the artifact names the
  related memory.
- **B7 — decision change / supersession.** A project-space memory seeds the
  historical storage decision (`cat:decision`). Session 1 records the replacement
  decision, keeps the historical memory content and marks it `status:superseded`,
  and links the new memory to the old one with `contradicts`; session 2 uses the
  new decision and writes `decision.txt`. The assertion checks the historical
  memory still exists with its category tag, original content and
  `status:superseded`, a new category-tagged memory holds the replacement
  decision, the link points new → old with label `contradicts`, no project name
  is duplicated, and the artifact names the new decision. The new memory name is
  not required.
- **B8 — tier maintenance (pinning and promotion).** Two T2 memories are seeded in
  a project space: an operationally critical `release-checklist` (`cat:decision`)
  and a `background-notes` reference (`cat:discovery`). Session 1 reviews both and
  must pin the checklist and move it to the active tier (T1) while leaving the
  background notes at T2 and unpinned; session 2 uses the checklist and writes
  `tier-plan.txt`. The assertion checks the checklist is T1 and pinned, the
  background notes remain T2 and unpinned (proving inspection did not promote
  them), no project memory name is duplicated, and the artifact names the
  checklist. It declares `requires: ['mind-memory']` (the implemented
  `memory_update` provides pin/promote), so it is not gated on tier-maintenance.
- **B9 — cross-session continuity.** Three sessions share the unit environment.
  Only session 1's prompt states the project fact; session 1 records it in a
  session summary, session 2 does a small related task and closes with a
  summary, and session 3 uses the preserved context and writes `continuity.txt`.
  The assertion requires at least one `type:session` + `cat:summary` memory at
  any tier (T1/T2/T3, since recovery auto-promotes it) that contains the fact, no
  duplicate summary names, and the artifact containing the fact version. The
  fixture itself does not contain the fact, so a workspace-only answer cannot
  pass.
- **B10 — semantic recall (paraphrase-only).** RAG is enabled for the unit. The
  seed writes two embedded project memories through the isolated CLI: a target
  fact (`Deployments rotate cryptographic keys every 24 hours.`) and a plausible
  distractor (`Deployments use blue-green rollouts.`). The single session prompt
  is a natural paraphrase with **zero content-word overlap** with the target
  ("How frequently are release credentials renewed?") and asks for `recall.txt`.
  The assertion requires the target memory to exist with a non-null embedding
  (checked read-only, never exposing vectors), the artifact to contain `24` and
  `hours`, the distractor's `blue-green`/`rollout` fact to be absent from the
  answer, and no duplicate target name. A free unit test verifies the prompt's
  lexical overlap is empty, proving the scenario tests meaning rather than term
  matching.
  B10 declares `rag: true` and `requires: ['mind-memory', 'semantic-recall']`.
  Without a Mind condition, the RAG embedding credential (currently
  `OPENROUTER_API_KEY` for the fixed `openrouter` provider) or an explicit RAG
  request, the runner records it **not_run** with a clear reason, zero sessions
  and zero failures. It never runs without RAG and never fails because RAG is
  absent. A real B10 result therefore needs a **paid run** with the authorized
  provider: the two seed `mind add` calls make embedding requests billed by the
  provider, and the session itself is a normal paid OpenCode session. Offline
  dry-runs use synthetic DBs/workspaces and the gated integration test.
- **B11 — skill-first activation and pending-work continuity (prepared, NOT
  run).** Two sessions share the unit environment. The seed installs the real
  canonical `mind-management` skill and its brief L2 activation through
  `mind setup opencode` in the isolated HOME, then adds that activation to the
  session config. Session 1 records an unresolved release-checklist item and
  leaves an active checkpoint with pending work; session 2 resumes that pending
  item and writes `resume.txt`. The assertion reads the raw transcript and the
  unit database and checks ordering **per session**, never in aggregate: each
  session must be `ok`, carry a non-empty transcript, have at least one Mind
  call, and load the exact `mind-management` skill before its first Mind call
  (the first Mind call may be `system_instructions`). A skill load in one
  session never covers another, and `system_instructions` after the skill load
  is rejected as redundant. Skill evidence is accepted either as a `skill` tool
  call whose arguments carry the id or as a `type: 'skill'` message whose
  `skill`/`name` is `mind-management`; a `skill` tool call without a usable id
  is reported as missing evidence, and the code-mode regex fallback can never
  prove a load. The assertion also requires an active checkpoint that still
  carries the pending item and a `resume.txt` that reflects it. Because the
  stored session results carry no timestamps, the checkpoint claim is
  provenance-limited to "**survived both sessions**"; it does not prove the
  checkpoint was created in session 1. It declares `requires: ['mind-memory']`,
  no RAG, and `allowedSkills: ['opencode','report','mind-management']` so the
  isolation gate treats the installed skill as expected rather than
  contamination. B11 is **gated and paid**: it is never executed by the free
  suites, no paid run is authorized, and its real result remains `not_run`.

  **What is verified for free vs unverified.** The gated
  `test/skill-discovery.integration.spec.ts` runs real `mind setup opencode` in a
  temporary HOME and verifies, with no model call, that OpenCode discovers
  `mind-management` from `~/.agents/skills/mind-management`, that the L2
  activation file is the brief instruction (not the full protocol), that the
  setup config points at it and registers the `mind` MCP server, and that
  `verifyIsolation` allows the installed skill. **Unverified without a paid
  B11 run:** that a real model loads `mind-management` (as a `skill` tool call
  with id `mind-management` or a `type: 'skill'` message) before its first Mind
  call **in each session**, uses the protocol instead of `system_instructions`,
  keeps a checkpoint pending across sessions, and behaves correctly after
  compaction (`OPENCODE_DISABLE_AUTOCOMPACT=1` also prevents testing compaction
  today). Tool _arguments_ are read best-effort from the raw transcript; when a
  build or provider omits them, the assertion reports the limitation instead of
  inventing a skill id.

B5/B6/B7/B8/B9/B11 declare `requires: ['mind-memory']`, so the `no-memory`
condition records them as `not_run` with zero sessions instead of executing a
memory task without a database. B10 additionally declares `rag: true` and
`requires: ['mind-memory', 'semantic-recall']`, so it is `not_run` without a Mind
condition **and** the embedding credential. Their seed/assertions use
`MIND_DB_PATH`/`MIND_DATA_DIR` from the isolated unit environment, never the live
database.

B6 seeds a **flat** space name (`b6-app`): the CLI `link` reference grammar is
`space/name` and splits at the first slash, so a nested `projects/...` space
cannot be addressed by the seed CLI. Fixing the CLI grammar is out of scope for
the harness. B7 seeds only memories (no CLI link), so it can use a nested
`projects/<name>` space.

How a scenario runs:

- **One fresh environment per (scenario × condition).** Each unit gets its own
  isolated OpenCode tree and workspace; the fixture is copied into the
  workspace. Mind conditions start from a **fresh empty database** (initialised
  via the pinned engine's own `mind status`; no ingestion — the agent populates
  it through MCP if it chooses).
- **Identical prompts across conditions.** Scenario prompts are module constants
  and are byte-identical for `no-memory`, `mind-v9` and `mind-v10`. They never
  name Mind, a memory product or an engine; they task the agent to preserve
  decisions/results for future sessions, so a memory-capable agent naturally
  uses its tools (measured, not required).
- **Sequential sessions, one process each.** Sessions run one at a time, each as
  a NEW OpenCode session (one worker process) sharing the unit's isolated env
  and data dirs, under the same step/timeout limits for all conditions.
- **Child capture.** Sub-agent sessions are captured via the driver
  (`session.children`), stored with parent linkage, and counted per scenario.
- **Assertions, not prose.** `makeAssertion(ctx)` inspects
  `{ workspaceDir, sessionResults, childResults, mindDb }` and returns
  `{ pass, details }`; agent prose is never accepted as success.
- **Budget.** Paid stages refuse to run without `--budget`; spend accumulates and
  aborts at the cap; per-stage statuses (`scenarios:<id>:<condition>`) are
  written to `meta.json`.

Offline coverage: scenario assertions are unit-tested on hand-crafted pass/fail
workspaces; the runner is dry-run with a fake driver (fresh DB, sequential
sessions, child capture, budget refusal/abort, byte-identical prompts); a gated
integration test (`BENCH_INTEGRATION=1`) exercises real fixture copies + fresh
DB init.

## Report (`REPORT.md`, free)

`report` reads a run directory (`meta.json`, `results/summary.json` and the
per-item result files) and writes a deterministic `REPORT.md` with 13 mandated
sections plus explicit conclusions. It never runs a probe, never invents
numbers, and refuses to emit anything that looks like a credential or a user
home path (a secret scan runs before the write).

`meta.json` is a **required** run artifact: a missing or malformed `meta.json`
throws by design, because it carries the run's identity, versions and stage
statuses. Only the per-item files under `results/*.json` are read defensively
(missing/corrupt result files degrade gracefully instead of failing the report).

- **Regenerate any time** from stored results:
  `make bench-agent-memory-report RUN=<run-id>` (or the CLI
  `report --run-id <id> [--out <path>]`). The default output is
  `benchmarks/agent-memory/REPORT.md`.
- **A and B stay separate.** Section 6 carries the A1 retrieval table, the A2
  answering table and the B scenarios table, plus v9→v10 absolute/relative
  diffs and a Mind-vs-`no-memory` comparison. No global mixed percentage is
  ever produced.
- **Honest about missing stages.** An A1-only run marks A2/B as `not_run`
  throughout instead of guessing.
- The aggregate `results/summary.json` is written next to the per-item results
  and is the machine-readable source of the report.

## Repetitions, baseline and per-category reporting

- **`--reps N` (default 1)** runs each (condition × question) N times, each in a
  fresh unit directory with its own per-question database copy and its own
  session. The blind judge makes one call per (question, rep) judging the
  candidates from **all** conditions of that rep.
- `results/a2-<condition>.json` holds one entry per (question, rep); a companion
  `results/a2-<condition>-means.json` holds the compact per-question view.
  Aggregates are the mean across reps.
- **Baseline.** The `no-memory` condition answers the _same_ questions/reps with
  the same prompt template (no DB, no MCP, `memory_calls = 0`).
- **Per-category + delta.** The report and `summary.json` break A2 down by the
  dataset-order categories (multi-hop, temporal, open-domain, single-hop,
  adversarial) and report the delta of `mind-v9`/`mind-v10` against `no-memory`,
  both overall and per category (absolute always; relative only when the
  baseline is non-zero).

## Curated results export

When `report` runs, it also writes a small, sanitized, **committable** artifact
set (outside the gitignored `runs/` tree):

```
benchmarks/agent-memory/results/<run-id>/
  summary.json        # RunSummary: meta, per-condition A1/A2/B, diffs, baseline deltas
  per-question.json   # one row per question: category, reference, per-condition per-rep verdicts
```

Both files are secret-scanned before writing (home paths, `sk-*`/`sk-or-*` keys,
bearer tokens, credential env assignments), so they are safe to commit. The
report itself still defaults to `benchmarks/agent-memory/REPORT.md`.

## T8b — full publishable run (30Q × 3 reps × {no-memory, mind-v10})

Run the stages in order, reusing one `RUN_ID` (omit `--run-id` on stage 1 to
generate one; the printed id is echoed by the CLI).

```sh
# Stage 1 (FREE): worktrees + dataset + ingest + A1 for mind-v10 (30Q subset)
bun run cli locomo \
  --subset full --conditions mind-v10 --run-id <RUN_ID>

# Stage 2 (PAID, cap $5): A2 answering + blind judge, 3 reps, mind-v10 + baseline
bun run cli locomo --answers \
  --run-id <RUN_ID> --conditions no-memory,mind-v10 --reps 3 --budget 5 --confirm

# Stage 3 (FREE): restyled REPORT.md + curated export under results/<RUN_ID>/
bun run cli report --run-id <RUN_ID>
```

## Extending with another engine

The harness talks to a memory system only through the `MemoryEngine` interface
in [`src/engines/adapter.ts`](src/engines/adapter.ts):

```ts
reset(runKey) · insert(userKey, text, meta) · insertMany? · flush(userKey)
search(userKey, query, k) · retrieve? · cleanup(userKey)
```

To add an engine, implement that interface (normalising any native score field
to `score`) and register a condition in `src/config.ts`.

**Mem0** is documented but not implemented (see the research report): its
ingestion is non-deterministic (per-turn LLM extraction) and it pulls a Python
stack, which would not be comparable under a single deterministic protocol. Use
the interface above as the integration point if it is added later.

## Cleanup

- Run output lives under `runs/` (gitignored); remove it with
  `make bench-agent-memory-clean`.
- `ALL=1` also removes the harness scratch under `.work/` (prepared worktrees +
  the dataset cache): `make bench-agent-memory-clean ALL=1`.
- The clean guard refuses to delete anything whose runs root is not named
  `runs` (and, with `ALL=1`, whose work root is not named `.work`), so it can
  never touch a path outside `benchmarks/agent-memory/`.
- Raw T1 probe captures live under `probes/evidence/` and are intentionally
  excluded from `prettier --check`.
