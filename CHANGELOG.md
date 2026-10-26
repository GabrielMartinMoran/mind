# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## Changelog Entry Style

Use concise, user-facing bullets under `## [Unreleased]`, grouped by:

- `### Added` — new features, commands, or capabilities.
- `### Changed` — behavior or architecture changes.
- `### Fixed` — bug fixes and regressions.
- `### Removed` — removed commands, APIs, or features.

Guidelines:

- Write one change per bullet, starting with an action verb (`Added`, `Refactored`, `Fixed`, `Removed`).
- Mention affected surface area when useful (e.g. `mind update`, `cli/src/api/routes/*`).
- Focus on **what changed and why it matters**, not implementation details.
- Keep internal refactors only if they impact maintainers, contributors, or users.

Example:

- `Added \`mind update --check\` to verify available releases without installing.`

## [Unreleased]

### Changed

- Documented the OmniMemEval LongMemEval-S 120-question Mind pilot alongside published systems with explicit sample-size, context-token, and comparability limits.
- Made the paid OmniMemEval workflow manual-only, with a 120-question default and optional 60- or 500-question runs.
- Changed search operators to be case-sensitive: only uppercase `AND`, `OR`, and `NOT` are boolean syntax, while their lowercase forms are ordinary terms. In punctuated natural-language questions, lowercase `and`/`or` are removed by the stopword filter and lowercase `not` remains a term.
- Changed punctuated natural-language recall to keep informative lexical candidates and let fusion rank complementary partial matches instead of discarding them; explicit uppercase `AND` stays strict and is excluded from semantic-only admission.
- Changed a supplied search with no informative terms after stopword removal (including empty, whitespace-only, and quoted stopword-only input) to raise one typed validation error before any retrieval or embedding work. CLI prints the message, MCP returns a tool error, HTTP returns 400, checkpoint recovery keeps its recent-memory fallback, and the OmniMemEval bridge returns 400. Omitting the field still lists memories (MCP) or returns an empty 200 response (API).
- Documented the current search contract—case-sensitive operators, supplied-query validation, admission, fusion, surface differences, and tests—in `docs/search-engine.md`, `README.md`, and `AGENTS.md`.
- Clarified search guidance for agents across the canonical protocol, MCP `memory_query` tool and `search` field descriptions, and CLI help: only uppercase `AND`, `OR`, and `NOT` are boolean operators, omitting `search` lists memories by metadata, and a supplied stopword-only query returns a validation error that requires a more specific topic, name, identifier, or code term. Bumped `instructions_version` to `2.3.0` for the updated fallback.

### Fixed

- Fixed punctuated natural-language questions (`?` or `¿`) losing partially matching memories whenever an exact match existed. Informative lexical matches now compete in the existing ranking, while common English/Spanish function words cannot seed a candidate; unpunctuated keyword searches and explicit operators retain their previous meaning.

### Added

- Added a default-off `--rag` switch to the agent-memory benchmark. When absent, every stage keeps `MIND_RAG=false` with no embedding-provider override; when passed, A1 ingest, the A1 search server, every A2 profile and every B scenario unit use `MIND_RAG=true` with the OpenRouter embedding provider, the run records `rag` in `meta.json`, and a post-ingest coverage gate aborts before A1 scoring if any ingested memory lacks an embedding.
- Added redacted execution evidence to agent-memory benchmark session results: each `result.json` keeps only ordered tool and skill names, nested code-mode tool names, parent/child session ids, recorded `memory_query` memory names with their `methods`, and the idle outcome. Prompts, message text, tool results, and memory contents are dropped before the file is written.
- Added `CONTRIBUTING.md` and `docs/mind-philosophy.md` to document contribution standards and Mind's purpose and product principles, with entry points from the README, docs index, and `AGENTS.md`.
- Added a self-hosted Lucide 0.547.0 icon sprite (`web/assets/icons.svg`) and a shared `createIcon` helper for web command actions, with no CDN or runtime icon package. The upstream ISC license and the MIT notice for Feather-derived portions are retained in `web/assets/vendor/LICENSE.lucide`.
- Added `GET /api/spaces/:space/tags`, which returns a space's distinct normalized memory tags in alphabetical order (empty for an unknown space). The web filter bar now uses a native **All tags** select populated from it, covering every tier and excluding space tags; a URL tag that is missing from the latest list stays selected as a temporary option.
- Added an additive `tier_counts {t1,t2,t3}` field to `GET /api/spaces` and MCP `space_list` (the three counts sum to `memory_count`). The All spaces cards use it for a proportional T1/T2/T3 spectrum and per-tier counts.
- Added MCP agent attribution: setup writes `MIND_AGENT` into each agent's `mind` MCP entry, the MCP server records it (with `clientInfo` as fallback) in `caller_info`, and the web Logs table shows an **Agent** column with compact labels. This is observability only; it does not add login or authorization.
- Added a lightweight pretty JSON viewer to the web memory panel: memories whose trimmed content is a valid JSON object or array render as two-space-indented JSON with colored keys and typed values (strings, numbers, booleans, null), with long lines scrolling inside the block, built from DOM text so user content is never parsed as HTML. Invalid or non-JSON content keeps the existing markdown/text renderer.
- Added a deterministic multi-lane radial layout for the web Neural Map plus dense-map culling (200 context edges, slimmer 7–16 px node radii, no persistent labels on dense maps and one transient hover/focus/selection label capped at 24 characters), so 300-node graphs render with zero overlapping nodes, every degree number, and a readable minimum gap down to 320 px. Tier boundaries keep equal 100-world-unit gaps for T1→T2 and T2→T3.
- Added an inline "Clear logs" action at the right of the Logs title row, with the table in an internally scrolling wrapper and a sticky header so long log pages are not clipped.
- Added a total-spaces count badge beside the sidebar "Spaces" heading and kept the three tier pills on one non-wrapping row in the rail.
- Added a refreshed web UI: tokenized dark design system, unified search with MCP-parity ranking plus `confidence`/`semantic` filters, client-side graph highlighting/only-matches with an accessible mirrored list, accessible list/panel/modals/logs, and URL-restored search/space/map state. See `docs/web-ui.md`.
- Added Pi Agent setup: MCP at `~/.pi/agent/mcp.json`, a managed brief activation block in `~/.pi/agent/AGENTS.md`, and the shared `~/.agents/skills/mind-management` skill. Mind installs no Pi plugin and marks Pi L3 unverified.
- Added `docs/agent-integration-matrix.md` with documented MCP and skill paths, symlink strategy, `initialize.instructions` support, hooks, Mind strategy, and honest documented/implemented/validated/unverified status for every supported agent.
- Added a separate skill-installation surface to setup diagnostics and `mind setup` output (`status`, path, and shared/symlink strategy), independent of the L1/L2/L3 badges.
- Added `docs/history/00009-memory-recall-investigation/memory-recall-improvement-analysis.md`, a decision-oriented technical analysis (Spanish, `[MEDIDO]`/`[CALCULADO]`/`[CÓDIGO]`/`[HIPÓTESIS]` evidence tags) of Mind memory recall: false-negative classification, focused-query and representation experiments, top-K/neighbor results, OpenCode consumption limits, write-side drift, consolidation costs, embeddings/admission findings, and a prioritized proposal table separating measured from expected impact.
- Added a Spanish handoff analysis document `benchmarks/agent-memory/ANALYSIS.md` for the agent-memory benchmark: measured facts, declared gaps (write side, benchmark B, v9, single conversation), the measured refutation that embeddings are the #1 lever, and prioritized experiments, with `[MEDIDO]`/`[CALCULADO]`/`[CÓDIGO]`/`[LITERATURA]`/`[HIPÓTESIS]` evidence tags.
- Added `--reps N` to the agent memory benchmark A2 stage (per (condition × question) repetitions, each in an isolated unit with its own per-question Mind DB copy) plus per-category A2 aggregation and `mind-v9`/`mind-v10` **delta vs the `no-memory` baseline**, reported in the restyled `REPORT.md` and the machine-readable `summary.json`.
- Added a curated, committable benchmark export under `benchmarks/agent-memory/results/<run-id>/` (`summary.json` + sanitized `per-question.json`), secret-scanned and written by the `report` stage outside the gitignored `runs/` tree.
- Restyled the benchmark `REPORT.md` to the repo's report conventions (header metadata block, `[MEDIDO]`/`[CALCULADO]`/`[CÓDIGO]`/`[LITERATURA]` evidence tags, per-category and baseline-delta tables, a protocol/comparability section, and a per-question appendix).
- Added a unified multi-strategy search pipeline shared by CLI `search`, MCP `memory_query(search)`, and `GET /api/search`. A query grammar (quoted `"phrases"`, `OR`, `AND`, `NOT`, trailing `*`) feeds an automatic relaxation ladder plus trigram substring, fuzzy (Damerau–Levenshtein ≤2), LIKE, token-set, and optional semantic channels, fused into one deterministic ranking with per-result `confidence` (`high|medium|low`) and `methods` provenance.
- Added `memories_fts_trigram` for substring/typo recall, migrated automatically under the migration-safety wrapper and synced in lockstep with `memories_fts`. It is a **contentless** FTS5 table (`content='', contentless_delete=1`) with `remove_diacritics 1` since v10, which fixes accent recall and shrinks the index (~19.9 MB on the real corpus after `−6.27 MB`; see `docs/search-engine.md`).
- Added a search relevance evaluation suite (`make search-eval`, `scripts/search-eval.ts`, `test/search-eval/`) with a deterministic fixture corpus, labeled cases, and a snapshot no-regression gate. The suite now has an immutable **v1** baseline (297 cases) plus a versioned **v2** (298 cases) with MRR and nDCG@10 and per-query ranking metrics.
- Added opt-in search benchmarking and differential tooling: `scripts/bench-search.ts` (`make bench-search`, `make bench-scalability CORPUS=1k|10k|50k|100k`) and `scripts/search-diff.ts` (`make search-diff`). These are outside `bun test`/CI; only aggregate artifacts are committed. Methodology: `docs/search-benchmarks.md`.
- Added an optional, **default-off** search diagnostics sink (`MIND_SEARCH_DIAG=1`) that emits per-channel counts and timings only — never memory content, names, or query text — with a byte-equivalence test when disabled.
- Added `test/fuzzy-search.spec.ts` pinning the P-A fuzzy channel (per-store vocabulary cache, banded OSA) and its documented prefix-3 limitation.
- Added embedding provider selection for RAG with `MIND_EMBEDDING_PROVIDER` (`openai` default or `openrouter`). OpenRouter uses `OPENROUTER_API_KEY` and the `openai/text-embedding-3-small` model slug. Both providers return 1536-dimension vectors, so existing stored embeddings remain valid without re-embedding.
- Added an opt-in **agent memory benchmark** harness under `benchmarks/agent-memory/` that compares OpenCode with no memory, Mind `main@36d2f1e` (schema 8) and Mind `develop@c7029b3` (schema 10) over a deterministic LoCoMo subset and real agent scenarios, with fail-closed environment isolation, worktree-pinned engines and a hard budget guard. It has no production impact and is driven by `make bench-agent-memory-*` targets; the paid stages require an explicit `--budget` cap.
- Added the **free LoCoMo A1 stage** to the benchmark harness (`make bench-agent-memory-locomo`, no LLM, no budget): a sha256-pinned runtime download of LoCoMo (never vendored; CC BY-NC 4.0), a seeded deterministic `conv-26` subset (pilot 5 / full 30), deterministic per-turn ingestion into both pinned engines with count/name-set verification, and retrieval metrics (hit@5/@10, evidenceRecall@10, MRR, precision@10, context tokens, latency) via each engine's own `GET /api/search`. Capability is documented in `benchmarks/agent-memory/README.md`.
- Added the **paid LoCoMo A2 answering + blind-judge stages** to the benchmark harness (`locomo --answers`, `locomo --judge-only --run-id <id>`, both requiring `--budget --confirm`): one process-isolated OpenCode session per (condition × question) on a byte-identical per-question Mind database copy, a condition-independent prompt template with a canonical abstention sentence, deterministic token-F1 scoring for categories 1–4 plus abstention/hallucination scoring for category 5, and an anonymized/order-randomized blind LLM judge whose condition mapping is kept out of the payload. Stage statuses are recorded in each run's `meta.json`.
- Added the **paid benchmark B scenario stages** to the benchmark harness (`scenarios --scenarios b1,b4`, requiring `--budget --confirm`): a scenario lifecycle runner that gives each (scenario × condition) its own isolated environment, workspace fixture copy and fresh empty Mind database, runs sessions sequentially as new OpenCode sessions (one worker process each) with byte-identical prompts across conditions, captures sub-agent child sessions, and evaluates concrete workspace assertions (never agent prose). Ships two fixtures — B1 (persistent architectural decision: no new deps, file-based JSON/JSONL under `data/`, UTC ISO-8601 timestamps, working `export`) and B4 (sub-agent transfer: bug fixed + child session captured).
- Added **result aggregation and a `REPORT.md` generator** to the benchmark harness (free): a pure aggregator that keeps A (LoCoMo A1/A2) and B (scenarios) metrics separate, computes per-condition rows with v9→v10 absolute/relative diffs and a Mind-vs-`no-memory` comparison, marks missing stages as `not_run` instead of inventing numbers, and writes `results/summary.json`. `make bench-agent-memory-report RUN=<id>` (or `report --run-id <id> [--out <path>]`) writes a deterministic 13-section report with explicit conclusions and a pre-write secret scan.
- Added the **`full` orchestration** to the benchmark harness (`make bench-agent-memory-full`): the free LoCoMo A1 stage always runs, the paid A2 and scenario stages run only when `BUDGET=<usd> CONFIRM=1` are supplied, and `REPORT.md` is generated from whatever landed.
- Changed `make bench-agent-memory-clean ALL=1` to also remove the harness scratch under `.work/` (worktrees + dataset cache), guarded so it never deletes a path whose runs root is not named `runs` (or work root not named `.work`).
- Added a **cross-harness Mind adapter** under `benchmarks/agent-memory/integrations/agent-memory-bench/` that runs Mind (`develop@c7029b3`) as a `MemorySystem` inside `hamza-dev-tech/agent-memory-bench` (MIT): CLI `add --tier 3` ingestion, `GET /api/search` retrieval via a per-run isolated `mind serve`, an idempotent installer for `scripts/run.py`, and a runtime-credential runner. Includes unit tests and a documented tiny validation run.
- Added the **cross-harness comparison artifacts** for the agent memory benchmark (`benchmarks/agent-memory/integrations/agent-memory-bench/COMPARISON.md` + `comparison.json`): a Mind row and a same-host Mem0 re-run on conv-26 (120 probes), a published-table block kept explicitly as non-comparable context, a LangMem ZDR-block raw evidence file (`evidence/langmem-block-404.txt`), and a measured diagnostic of where Mind's recall comes from (retrieval hit@10 vs answering-with-complete-evidence). No production impact.
- Added a `--rag off|on` condition switch to the cross-harness Mind runner/adapter (default `off`), with a mandatory post-ingest embeddings verification (`mind status` → `X/Y indexed`) that aborts instead of silently grading a degraded lexical run, plus a same-protocol RAG-ON row in `COMPARISON.md`/`comparison.json` (OpenRouter `text-embedding-3-small`). No production impact.
- Added `pinned` and `tierTransition` (`promote`/`demote`) to MCP `memory_update`. Updates stay atomic through one `patchMemory` call, an empty update returns the existing memory, and existing calls keep working unchanged.
- Added `label` and `direction` (`outgoing`/`incoming`) to the linked summaries returned by `memory_read`, and fixed directional resolution so checkpoint recovery no longer includes the checkpoint itself through an incoming link.
- Added a `references` block of living references to `space_get`, plus bounded T3 previews that report returned count and total availability instead of scanning the whole tier.
- Added the B5–B10 real-agent scenarios to the benchmark harness (durable writing, relinking, supersession, tier maintenance, cross-session continuity, and semantic recall) with per-scenario RAG control, isolated databases, and `not_run` gating. Execution evidence remains in `.pas/`; the durable behavior is summarized in `docs/cognitive-memory-lifecycle.md`.
- Added `docs/cognitive-memory-lifecycle.md` (memory model, tiers, lifecycle, writing, supersession, linking, living references, tool usage).
- Added `docs/skill-first-distribution.md` (single protocol source, complete skill, brief activation, installation model, lifecycle corrections).
- Added the scoped merge-readiness corrections, including lockfile/CI changes, checkpoint atomicity guarantees, and the split between free OpenCode validation and unrun paid B11.
- Added a free, gated OpenCode 2.0.28 skill-discovery integration test (`BENCH_INTEGRATION=1`) covering canonical skill discovery, brief L2 activation, MCP config/handshake, `/api/skill` polling, and the isolation allowlist without a model call.
- Added a prepared, gated benchmark B11 scenario for skill-first activation and pending-work continuity. It is paid, not run, and its live result remains `not_run`.
- Added `docs/README.md`, a living documentation index that groups memory, search, agents, development, benchmarks, releases, and historical reports, with a one-sentence answer for each entry.
- Added `docs/search-engine.md`, a living page for current channels, admission, schema v10 storage, the fuzzy prefix-3 limit, the host-specific performance envelope, and reproduction links.
- Added `test/docs-links.spec.ts` to enforce the living-doc index, resolvable relative links, frozen history banners, and the absence of temporal reports in the docs root.
- Added the documentation philosophy and maintenance policy in `AGENTS.md` §6 (living vs historical, status vocabulary, locations, update-before-create, link maintenance, update matrix, and review checklist).
- Added a local search to the web **All spaces** view: it filters visible spaces by name, description, and tags (case- and accent-insensitive AND tokens) without a backend request, shows a live result count and a concise no-results message, and clears from a single in-field control while keeping focus.

### Changed

- Expanded `docs/search-engine.md` into the end-to-end search reference: pipeline stages and entry points, query grammar, all eight `methods` values (with `token_set` documented as scoring-only), admission order, fusion and confidence, surface filters and pagination, RAG conditions, diagnostics, and known limits. Corrected `search_method` as an MCP-only top-result projection and clarified that embedding dimensions are not schema-enforced.
- Changed bare `mind setup` to configure all supported agent integrations; moved the compatibility matrix to `mind setup compatibility` and kept `mind setup refresh` for detected integrations. A failing agent no longer aborts the run: its error is reported and the remaining agents still run, and the success summary is printed only when every agent succeeds.
- Changed the cognitive protocol to use recent memory changes as an on-demand fallback for vague continuity or recent-work questions, with limits on scope, promotion, and claims of completeness; bumped `instructions_version` to `2.2.0` for the updated fallback.
- Changed web command actions to consistent Lucide icons with visible labels by default: Logs is a visible secondary topbar action, New space is quieter, New memory sits beside the space title in List and Neural Map, and icon-only mobile actions keep descriptive accessible names. Destructive triggers are outlined while only the final delete confirmation is solid, and tier, filter, pagination, and badge marks stay icon-free.
- Changed search result tags to passive data chips outside the result anchor, made removable space and memory tags named buttons with decorative remove icons, and added decorative icons to list, search, panel, logs, graph, dialog, and toast commands.
- Changed the web space filter bar to one centered row at desktop widths: search, tag, tier chips, confidence, embeddings, only-matches, and Clear filters share the same line, the search field is compact (280 px below 1360 px and 340 px at or above 1360 px), visible field labels became placeholders plus visually hidden labels, and the embeddings help text moved to `aria-describedby` and a tooltip. Below 700 px the search takes a full row and the remaining controls wrap without horizontal overflow.
- Changed the web space view to a single shared filter bar (search, tag, multi-select tier chips, Clear filters) across list, Neural Map, and in-space search, and removed the duplicated per-view filter controls. Tier chips are inclusive; one active tier keeps `tier=N`, two active tiers use `tiers=N,M`, and all three active tiers omit the parameter. `GET /api/memories/query` and `GET /api/search` accept `tiers` while `tier` stays compatible (`tiers` takes precedence).
- Changed web memory cards to a clearer one-row hierarchy: a compact tier marker (colored dot + `T2`) leads, the truncated name follows, and tags plus the tabular changed date sit at the right edge (about 42–44 px tall). Tags grow left from the right-aligned changed date to use available row space, truncate only when the row is constrained, and never overlap the name. The card pin button was removed; pinning remains in the memory panel, and a pinned memory shows a passive text indicator. Below 860 px the tier and name share a row and metadata wraps beneath it.
- Changed the web **All spaces** cards to show per-tier signal: a 6 px proportional T1/T2/T3 spectrum, tier-colored counts, a clamped description, and a footer with the total and up to three tags plus `+N`. Spaces with no memories show a neutral "No memories yet" state instead of three zero counts, and card rows keep equal heights down to 320 px.
- Changed the sidebar tier pills to distribute across the full rail with `justify-content: space-between` while staying on one non-wrapping row at 240 px, including large counts.
- Changed the web navigation so **All spaces** is the first sidebar entry (a real anchor to `/`, active only on home) and removed the topbar "Atlas / All spaces" breadcrumb.
- Changed the web Neural Map selection so a selected memory highlights its incoming and outgoing edges, emphasizes its neighbors, mutes unrelated edges, and keeps the modal backdrop light enough to read the map; labels render at 11.5–13 px of screen space with a contrast halo, and the open-space search clear control is always visible inside the input (`type="text"`, no native X).
- Changed the web Neural Map to request and render every available node (up to the backend's 1,000-node maximum) instead of stopping at 300, and removed the "Load full graph" action. Dense 465/567-node spaces keep the P2a layout and culling (zero overlaps, no persistent labels, bounded edges), and a backend-capped payload now shows only a quiet "Showing X of Y" note.
- Changed the web Neural Map so dragging to pan never selects graph text while the accessible memory table stays selectable/copyable, and aligned the graph, list, and space content on a shared 16 px right/bottom gutter.
- Changed skill activation to make `mind-management` the single source of truth for Mind: load it unconditionally at session start and after compaction before any Mind use, treat AGENTS.md/L2/MCP initialize/tool descriptions/docs as activation pointers only, use `system_instructions` when the skill is not listed or cannot be loaded, and document project `AGENTS.md` precedence in `docs/skill-first-distribution.md` and `docs/agent-integration-matrix.md`.
- Corrected documented agent MCP paths: Windsurf/Devin now writes `~/.config/devin/mcp_config.json` (legacy `~/.windsurf/mcp.json` is detection-only), VS Code/Copilot writes portable `~/.copilot/mcp-config.json`, and Antigravity writes `~/.gemini/config/mcp_config.json`.
- Changed Cursor hooks to the documented `{ "version": 1, "hooks": { ... } }` schema with `sessionStart`, `preCompact`, `sessionEnd`, and `stop`, preserving unrelated entries and migrating the old top-level map. Cursor L3 is now marked unverified because hook execution was not live-tested.
- Changed Codex, Gemini CLI, VS Code/Copilot, and Antigravity L3 evidence to state that those clients document hooks but Mind implements no automation for them.
- Changed the trigram index to fold diacritics (`tokenize='trigram remove_diacritics 1'`) and to be contentless (`content='', contentless_delete=1`), fixing silent substring recall on accented text (`figuracio` now finds `configuración`) and reducing its storage (schema v10).
- Changed the fuzzy channel to **P-A-only**: candidates come from the full folded document vocabulary, folded once and cached per store (invalidated by a write-generation counter), scored with a banded/early-exit OSA ≤2 and a deterministic order. This removes the previous query-dependent, unordered `LIMIT 2000` prefilter (determinism) and the per-query re-folding.
- Refactored the fuzzy expansion scan to reuse the cached, already unique-and-sorted vocabulary instead of re-copying, de-duplicating and sorting it on every query. Expansion order and results are unchanged; on the real corpus (4 497 memories, `|V|≈29 890`) the scan itself is ~18–20× faster (p50 6.5 ms → 0.35 ms per token).
- Consolidated the schema to a single definitive **v10**. The intermediate schemas v10 (with a per-document `search_terms`/`memory_terms` dictionary) and v11 (dictionary retired) were development-only and never published; the last published schema was v9, so `MIGRATE_V9_TO_V10` now builds the final state directly (trigram `tokenize='trigram remove_diacritics 1'` + `content=''` + `contentless_delete=1`; no dictionary tables) and the dev-only `v10→v11` migration and guard were removed. Dev databases still stamped version 11 can be normalized to 10 with the opt-in `scripts/normalize-dev-db.ts` (copies only). Net effect at 50k: `−14.1 %` compact DB and `−25.3 %` trigram index versus the pre-optimization engine, with no write-path regression.
- Changed CLI `search` to default to 25 results (previously unlimited) and to support `--limit`/`--offset` with a 500-result page cap; output now marks each result with a `[high]`/`[medium]`/`[low]` confidence bucket.
- Changed MCP `memory_query` search results to include `confidence` and `methods`, plus `total`/`limit`/`offset` and a `search_method` compatibility mapping; `GET /api/search` now accepts `limit`/`offset`. All surfaces share one ranking and the previous CLI/API vs MCP divergence is retired.
- Changed search to degrade gracefully: with RAG off the semantic channel is omitted silently, and a query-time embedding failure opens a ~5-minute in-memory breaker instead of retrying on every query.
- Changed the `MIND_LOG_RETENTION_MINUTES` default from 360 (6 hours) to 10080 (7 days) to match the documented value.
- Changed `mind status` to report the active RAG embedding provider with provider-specific hints for a missing key, an invalid provider value, or disabled RAG.
- Changed semantic search admission to be independent of the lexical gate: natural-language queries (one group, no `NOT`, only plain terms) admit semantic-only candidates at cosine ≥0.6 even when lexical results exist, while explicit phrases, prefixes, and operators stay lexical. RAG remains optional and off by default, and RAG-off results are unchanged.
- Changed the agent protocol to a single canonical six-responsibility body (ORIENT, RECALL, LEARN, RELATE, MAINTAIN, HANDOFF) rendered into the L2 agent template, MCP `system_instructions`, and the installed `mind-management` skill. `instructions_version` moved to `2.0.0` for that consolidated body; subsequent checkpoint, supersession, and skill-first changes advanced it to `2.1.0`. The protocol no longer presents `system_instructions` as a required first call.
- Changed skill distribution to one complete `mind-management` skill at `~/.agents/skills/mind-management`. Claude Code and Antigravity receive a symlink or managed copy; clients that read `~/.agents` use it directly; Mind-managed shadow copies are migrated without discoverable backups; foreign skill files are never overwritten. Writes use ownership markers, atomic temp-file renames, and a Windows junction/copy fallback.
- Changed L2 setup instructions and MCP `initialize.instructions` to brief skill activation only. The installed skill carries the complete protocol, and `system_instructions` remains the complete fallback.
- Changed checkpoint semantics: omitted fields are preserved, an empty string clears a field, defaults apply only on creation, and a no-op does not advance `updated_at`. Active checkpoints are found in every tier, and `linked_memories` is additive with `links_failed` reporting.
- Changed `checkpoint_done` to require empty `pending` and a `checkpoint`-tagged target. Ending a session with pending work updates and keeps the checkpoint; the OpenCode plugin no longer creates placeholder checkpoints. On success, completion still creates a T3 `session-*` summary and copies links in both directions.
- Changed supersession guidance and examples: create the replacement, preserve the historical content and original category tag, add `status:superseded`, link replacement to history with `contradicts`, and update living references. RECALL now starts with a natural query, and RELATE distinguishes generic `links_to` from specific `link_create`.
- Changed the agent memory benchmark into an independent Bun subproject under `benchmarks/agent-memory/` with its own `package.json`, `bun.lock`, and `tsconfig.json`. It declares `@opencode/sdk@2.0.28` itself; the root project is not a workspace and does not install benchmark dependencies. CI adds a free benchmark job for typecheck, unit and contract tests, and experiments.
- Changed Cursor and Gemini CLI L1 diagnostics to describe stdio command transport instead of a URL, and clarified that Antigravity has no L2 instruction injection; its skill remains a separate surface.
- Changed skill installation to an exact-name policy: only `mind-management` in a managed path is installed or updated, with or without the ownership marker (the marker is provenance, not authorization); other skills are never touched, and content-signature heuristics were removed. Updates replace `SKILL.md` atomically without skill backups, preserve extras, and handle foreign/broken symlinks and `ENOTDIR` paths safely.
- Changed `checkpoint_done` to complete atomically: summary, inbound/outbound link copies with labels and directions, and checkpoint deletion commit in one synchronous SQLite transaction; any failure rolls back, and a retry cannot duplicate the summary.
- Changed CI to use `bun run format:check`, `bun run typecheck`, Bun 1.3.14, and frozen root and benchmark installs. Both the root and benchmark jobs now run `bun audit --audit-level=high` as a blocking security gate after installation.
- Changed dependency security posture: bumped `@modelcontextprotocol/sdk` from 1.27.1 to 1.32.1 and added root overrides for patched express/hono/fast-uri/ip-address/path-to-regexp/qs/body-parser/proxy-addr/js-yaml/@humanfs/node/brace-expansion. The root `bun audit` is now clean (0 advisories). Added benchmark overrides `@modelcontextprotocol/client`/`@modelcontextprotocol/core` 2.3.1 and `@parcel/watcher` 2.6.0 while keeping `@opencode/sdk` 2.0.28; the benchmark high audit passes with one residual low `@ai-sdk/provider-utils` advisory. Pinned `@types/bun` 1.2.10 and `prettier` 3.8.1 to avoid unrelated toolchain regressions.
- Changed the root to Bun-only: `bun.lock` is the only lockfile and the release script no longer reads, writes, or aligns npm-lock versions.
- Changed OpenCode skill-first status: free discovery/config/handshake is validated on 2.0.28; paid B11 and live model behavior remain unverified.
- Changed benchmark B11 to verify skill-before-Mind ordering per session instead of in aggregate, accept both `skill` tool calls and `type: 'skill'` messages, reject `system_instructions` after the skill, and fail explicitly when per-session evidence is missing. The paid run is still not executed.
- Changed the documentation layout so living pages are the default: temporal reports were moved into `docs/history/<feature>/` with frozen banners, cross-links were fixed, and the benchmark report generator was redirected to the living search page. A later cleanup retained only exceptional historical evidence and removed the rest after extracting durable conclusions.
- Changed the documentation policy so `docs/history/` is not an automatic archive: only exceptional evidence with durable technical value is retained, and execution, merge, and validation reports stay in `.pas/`.
- Changed `docs/README.md` to list the six living pages and the three retained historical reports explicitly.
- Changed the documentation link tests to enforce invariants (index coverage, banners, non-empty files, relative links, release notes, and policy phrases) instead of a fixed report list and count.
- Changed the benchmark `REPORT.md` header to link the living search-engine page instead of the frozen optimization report.
- Changed the agent memory benchmark documentation to describe `mind-current` as the default condition, explicit historical comparisons, current-only B11, nine scenarios, optional historical worktrees, single-condition absolute reports, B10 limitations, and the measured residual benchmark advisories. Corrected the three `AGENTS.md` search-pipeline descriptions from parallel channels to logically independent channels executed sequentially on one synchronous SQLite connection.
- Changed every `mind-current` benchmark A2 condition and B1–B11 unit to run the real `<checkout>/mind setup opencode` once per isolated environment, applying the same `mind` MCP server, canonical `mind-management` skill, brief L2 activation, and `system_instructions` fallback as a normal OpenCode install. A1 does not prepare, and `mind-v9`/`mind-v10`/`no-memory` keep their original integration. Current-versus-historical comparisons now include skill and L2 overhead; paid budgets require re-approval.
- Changed benchmark B11 to use that shared preparation instead of its seed-time installer, L2 helper, and skill allowlist; its prompts, fixture, `requires: ['mind-memory', 'skill-first']`, and per-session ordering assertion are unchanged. Benchmark isolation now derives the expected skill surface from the condition and fails closed on a silent installer no-op.
- Updated the benchmark, skill-first distribution, agent integration, verification harness, and `AGENTS.md` documentation for shared current-only setup and all-branch CI without claiming an unobserved hosted run.
- Changed Neural Map nodes to size by combined in/out degree (square-root radius 8.5–21 px, capped for dense graphs) and to render the link count centered inside each node with a fitted 8–13 px font, with the count also exposed in each node's accessible label.
- Polished the web UI: search now lives inside the open space (its input in the space header, `/` to focus) instead of a global topbar field; topbar actions share one height and padding contract, the destructive space action sits last on the right, the sidebar close control is mobile-only, and the graph's accessible memory table is a collapsible "Memory list" (open at 50 or fewer nodes, collapsed for dense graphs).
- Changed the web **Delete space** action to pair the local `trash-2` icon with its visible label while staying an outlined destructive trigger.
- Changed the wide web layout: at 1360 px and wider the in-space search uses a 340 px basis with 12 px primary filter gaps, and All spaces uses four equal columns across the available width; below 1360 px the search keeps a 280 px basis with 8 px gaps and the card grid keeps its adaptive auto-fit layout. The 1280 px one-row filter contract and the ≤320 px search width still hold.
- Changed the web Neural Map so a plain primary click on a **Memory List** row opens the memory panel and selects/highlights the matching node in place without refetching the graph; modifier-click and middle-click stay native anchors.
- Changed the agent-memory benchmark dependency graph so its single flat `zod` override resolves every consumer to zod 4.6.7, including `gitlab-ai-provider`, which declares zod 3. The free unit, contract, and experiment suites and the no-paid smoke path passed; no live GitLab provider call was exercised.

### Fixed

- Fixed agent-memory benchmark sessions sharing one OpenCode database. Each A2 answering unit and each B-scenario session now owns its own `opencode.db`, because the explicit `database.path` binding persists sessions into a shared store, so the next unit or session trips the fail-closed empty-session isolation gate and is rejected as contaminated. `MIND_DB_PATH` stays shared per unit, so scenario continuity is unchanged.
- Fixed invalid `from`/`to` date bounds failing differently by path: every date-filtering surface now throws `Invalid date value: <raw>` instead of the MCP in-memory filters silently returning no rows, so store queries, `checkpoint_query`, and `memory_query` (with or without `search`) report the same error.
- Fixed `checkpoint_query` and `memory_query` date-range filtering on hosts with non-UTC local timezones. Zone-less `changed_at` values are parsed as UTC, and every `from`/`to` bound resolves through one shared parser to the same whole-second UTC instant as `changed_at`, which is stored at second precision: a date-only bound covers the full UTC day (`from` at 00:00:00, `to` at 23:59:59), a time-bearing bound is honored at that instant instead of being widened (zone-less values such as `2026-10-24T12:00:00` are read as UTC, explicit offsets such as `2026-10-24 12:00:00+02:00` are converted to UTC, and fractional seconds floor to the whole second, so `12:00:00.500` resolves to `12:00:00`), and `from`/`to` are symmetric. The store SQL path and the MCP filter use the same parser and the same whole-second resolution, so the same bounds select the same rows on both paths whatever the host timezone. This is a deliberate semantic alignment: date-only bounds are UTC dates, not host-local days.
- Fixed agent-memory benchmark B verdicts over unobservable evidence. B4 now reports "no child" only after a successful child-session capture (unavailable child evidence after a recorded `subagent` call is a harness error), B11 records unavailable or empty message evidence as a harness error instead of a skill-order failure, and B10 passes only when a recorded target `memory_query` result includes `semantic` in its `methods` rather than relying on embedding presence and a correct artifact. Harness errors are stored as `not_run` with a reason and excluded from failed counts.
- Fixed the agent-memory benchmark isolation gate rejecting valid `mind-current` environments during a cold start. `verifyIsolation` now polls `/api/skill` a bounded number of times until the exact allowlisted surface appears, evaluates the skills allowlist and skill-first checks against that final listing, and saves it as evidence; a skill that never appears still fails closed with its id.
- Fixed clearing an in-space query so stale search results are removed without another search request and a matching memory list is reused.
- Fixed long in-space search result lists being clipped by the fixed-height space view: results now scroll inside their own region while the space header, shared filter bar, and result status stay visible, with no page scroll. At phone widths the tag select pairs with the tier chips and confidence pairs with embeddings, so the results body keeps at least 120 px at 320x700 instead of collapsing to 111 px.
- Fixed the web sidebar space count so it always reflects the global total after visiting a space; the All spaces view no longer renders a space-scoped summary.
- Fixed the web JSON viewer scrolling horizontally on long keys and string values; JSON now wraps inside the panel (with two-space indentation preserved) and never widens it.
- Fixed dense Neural Maps omitting a low-degree selected node's links when the 200-edge context cap filled first. Selecting a node now materialises every missing incident edge from the full graph payload (both directions) as a DOM-only patch, and deselecting removes those transient edges without rebuilding the map or refetching.
- Fixed web infrastructure gaps exposed by the refresh: web sources are now type-checked, `marked` is vendored locally instead of loaded from a CDN, unknown `/api/*` routes return JSON 404, the memory detail presenter strips internal fields, and the Docker image/compose port configuration agrees.
- Fixed `mind setup` leaving persistent `SKILL.md.bak.*` and `mind-management.bak.*` artifacts inside agent skill discovery roots. Managed skill updates now replace content atomically without skill backups; ancestor-repair and agent config backups remain, and existing skill backups are not auto-deleted.
- Fixed GitHub Actions only running on slash-free branches: CI now triggers on every push and pull request (including `feat/`, `fix/`, and nested names) plus manual dispatch, with unchanged independent jobs, frozen installs, and blocking high-severity audits.
- Fixed silent search recall on accented/partial words (R1): folding diacritics in the trigram tokenizer makes accented and unaccented queries match both ways.
- Fixed non-deterministic fuzzy candidate selection: the old unordered `LIMIT 2000` vocabulary prefilter is gone; fuzzy tokens, vocabulary, and expansions are sorted and the fuzzy expansion list is deterministic.
- Fixed non-deterministic search ordering by replacing the numeric identifier tie-break (which produced `NaN` on UUIDs) with a stable name/id string comparison.
- Fixed OpenCode automation plugin loading on OpenCode V2. The generated `~/.config/opencode/plugins/mind-automation.js` default-exports a V2 plugin definition (`id` + `setup`) and registers V2 session hooks (`context`, `compaction`) plus `ctx.event.subscribe`, while keeping the V1 `server()` hooks for backward compatibility. V2 changed the plugin API and rejects V1 modules with `Plugin must export a default definition with an id and an effect or setup function`. The object-entrypoint V1 form requires OpenCode 1.18.29 or newer.
- Fixed OpenCode V2 automation to resolve one project space per canonical project path. The event's `location.project.canonical` now takes precedence over `location.directory`, so continuity artifacts no longer land in `projects/<event-directory>` when events come from a nested or different directory.
- Fixed OpenCode V2 automation writing plugin state for every streamed event. State is now written only after state-changing events (`session.created`, compaction, `session.deleted`), and the checkpoint, summary, and handled maps are capped to the newest 400 entries.
- Fixed OpenCode V2 session id extraction to skip empty or non-string fields so later fallbacks still resolve (for example, an empty `payload.sessionID` no longer masks `payload.sessionId`).
- Fixed OpenCode V1 automation using the bus event id instead of the session id. The generated plugin now resolves the session identity from V1 event `properties` (`properties.sessionID`, `properties.session.id`, or `properties.info.id`) before falling back to the legacy event id, so checkpoint dedupe keys and session summary names use the real session.
- Fixed the agent memory benchmark's isolated MCP registration on OpenCode 2.0.28. The in-process SDK host does not read `OPENCODE_CONFIG_CONTENT` on its own, so the driver now hands it the inline config explicitly (`OpenCode.create({ config: { content, directory } })`); the fail-closed `mcp list` check retries a bounded number of times to absorb the background-service warm-up race; and code-mode (`execute`) tool calls are unwrapped so real `mind.*` calls are counted. The A2 stage now runs real sessions that use Mind.
- Fixed benchmark harness secret hygiene: worker `job.json` files (and the raw A2 result dump) redact credential env values at write time, so a provider key is never persisted even transiently. The harness also records `opencode`/SDK versions in `meta.json` and accumulates A2 + judge costs into `meta.budget.spentUsd`.
- Fixed the agent memory benchmark per-question Mind database isolation: the per-question DB copy produced by A2 is now actually applied to the child environment and the `mind` MCP server config (`MIND_DB_PATH`/`MIND_DATA_DIR`/`MIND_SYNC_ROOT`), so questions no longer share one condition database. The free `locomo` stage also closes its `locomo:start` stage instead of leaving it `running`.
- Fixed the agent-memory-bench Mind adapter to always reap its per-run `mind serve` (own process group; SIGTERM then SIGKILL with wait; `atexit` safety net), so no server process survives a run even when teardown is skipped.
- Fixed the cross-harness comparison documentation (`COMPARISON.md`, `README.md`, `comparison.json`): removed the false claim that RAG-on improved temporal recall (it regressed 54.5 % → 50.0 %), corrected the `flush` row (it verifies embeddings when `--rag on`), scoped the 419/419 embeddings assertion to ingest-side document embeddings, and ordered the levers by impact (evidence granularity #1, embeddings #2). Added a sanitized embeddings-verification evidence file and a fail-closed unit test for `_verify_embeddings`.
- Fixed link ordering to be deterministic (`created_at DESC, rowid DESC`) and aligned link documentation with the implementation: `link_create` relabels the same directed pair, `link_delete` is an idempotent no-op when the link is absent, and `memory_read` reports each relation's label and direction.
- Fixed checkpoint partial updates erasing omitted goal, pending, and notes fields. Omitted fields now keep their values, and a no-op returns the checkpoint without touching `updated_at`.
- Fixed `checkpoint_done` accepting incomplete work or a target that is not a checkpoint. It now rejects pending work with an actionable error, leaves the checkpoint active, and creates no summary until the work is complete.
- Fixed the supersession example that rewrote a historical memory with the new truth. Every `memory_update` example that sends `status:superseded` now omits `content`.
- Fixed skill updates writing through a foreign symlink, reporting a broken symlink as installed, raising `ENOTDIR` on a non-directory managed path, and relying on historical content signatures to recognize old copies.
- Fixed `checkpoint_done` partial states: a link or delete failure no longer loses a relation, leaves both summary and checkpoint, or duplicates the summary on retry.
- Fixed CI format checking so it detects drift instead of rewriting files, and removed the `npm audit || true` step that hid real advisories.
- Fixed two high-severity advisories in the dependency graphs without changing runtime surfaces: raised the root `body-parser` override from 2.3.0 to 2.4.0 (GHSA-27r3-jxmh-p828) and added a flat top-level `zod` override, 4.6.7, to the agent-memory benchmark (GHSA-mrhx-c7xc-m3w5). Both graphs now pass `bun audit --audit-level=high` on Bun 1.3.14; the benchmark's default audit still reports one low `@ai-sdk/provider-utils` advisory through the pinned `@opencode/sdk@2.0.28`.

### Removed

- Removed the global `/search` route and topbar search field from the web SPA; visiting `/search` now canonicalizes to `/` or the currently open space, and search is scoped to the open space.
- Removed `@opencode/sdk` from the root dependencies; it now belongs to the benchmark subproject. Removed the unused `bun-style` dependency; terminal styling uses `ansi-styles`.
- Removed the stale root `package-lock.json`; `bun.lock` is the only root lockfile. Removed npm-lock handling from `scripts/release.sh` and the matching test fixtures.
- Removed six temporal historical reports after extracting their durable conclusions into `docs/search-engine.md`, `docs/search-benchmarks.md`, and the existing living pages: the search audit, search optimization plan, search follow-up implementation report, cognitive-memory-lifecycle implementation report, skill-first-distribution implementation report, and merge-readiness report.

## [1.6.0] - 2026-06-30

### Fixed

- MCP `memory_query` LIKE fallback search no longer fails with `no such column: s.name` when FTS5 returns no results.
- OpenCode automation plugin: reduced session summary noise by ~95%. The plugin now only persists a session summary on `session.deleted` (fires once per session) instead of also on `session.idle` (fires 20-50 times per session), eliminating redundant empty-summary noise.

### Changed

- Memory protocol guidance refined: agents now receive clearer instructions on when to create durable memories (stable decisions, verified root causes, reusable patterns) with a pre-creation checklist distinguishing them from session summaries (routine progress, no new findings).
- Added living reference taxonomy guidance for project maps, key decisions, known pitfalls, and 30-day maintenance reviews.

## [1.5.1] - 2026-06-18

### Fixed

- Fixed Neural Map layouts for spaces backed by UUID memory IDs so graph nodes
  stay positioned around tier rings instead of collapsing near the upper-left
  origin.

## [1.5.0] - 2026-06-07

### Added

- Added autosync commands that mirror spaces into versioned `.mind/` files,
  making project memories easier to review, share, and recover.
- Added `mind setup refresh` so existing agent integrations can stay aligned
  after updates without recreating unrelated configs.
- Added `mind migrate sessions <project-space> [--dry-run]` to move older
  `sessions/<repo>` summaries into the project space with preserved links.
- Added maintainer release automation support for curated GitHub release notes
  with `--notes-file <path>` and package-lock version alignment.
- Added `opencode.jsonc` support for OpenCode: `mind setup opencode` now
  prefers `~/.config/opencode/opencode.jsonc` over `opencode.json` when both
  exist, and never creates `opencode.json` if `opencode.jsonc` is already
  present. The new safe-config helpers (`src/setup/safe-config.ts`) parse
  JSONC with comments and trailing commas, and use `jsonc-parser.modify` to
  preserve comments when editing existing keys.

### Changed

- Changed database migrations to create verified backups, restore automatically
  on migration failures, and keep the latest automatic backups.
- Changed `mind update` to validate migrations before refreshing integrations,
  reducing the chance of an update leaving agents on stale protocol files.
- Changed session summaries to live in `projects/<repo>` as same-space
  `session-*` memories. If you have older summaries under `sessions/<repo>`,
  run `mind setup` after `mind update`, then run
  `mind migrate sessions projects/<repo> --dry-run` first and
  `mind migrate sessions projects/<repo>` after you review the dry run.
- **UUID Primary IDs migration**: Converted `spaces` and `memories` from INTEGER AUTOINCREMENT to UUID TEXT primary keys. Added `memories.fts_id` (INTEGER) as local surrogate for SQLite FTS5 rowid. Added `memories.space_id` (TEXT FK) normalizing the relationship to `spaces`. Added `fts_id_sequence` table for transactional ID assignment. Migrated autosync to manifest v1 with UUID entries and space UUID directories. MCP/CLI public contracts preserved (name-based). Schema version 7 → 8.

### Fixed

- Fixed a critical data-loss bug in `mind setup` and `mind setup refresh` where
  a malformed JSON/JSONC config file could be silently overwritten with an
  empty default, destroying the user's existing agent configuration. Setup now
  parses existing files strictly, aborts the run on parse failure, and creates
  a timestamped backup before any content-changing write. Writes go through a
  temp-file-then-rename so a crash mid-write cannot leave a partial file in
  place. Affects all supported agents: opencode, claude-code, codex, cursor,
  windsurf, gemini-cli, vscode, antigravity.
- Fixed a Codex `~/.codex/config.toml` regression where the file was appended
  via raw text instead of the safe-config pipeline. A malformed TOML file no
  longer crashes setup, an outdated `[mcp_servers.mind]` stanza is now
  replaced in place while preserving unrelated tables and comments, and
  `isAgentIntegrationDetected('codex')` no longer probes the TOML file with
  `JSON.parse` (it now uses a TOML-aware probe). `MalformedConfigError.parser`
  is widened to `'json' | 'jsonc' | 'toml'`. The Codex write path now goes
  through `readTomlOrThrow` + `safeWriteToml` (Bun.TOML.parse with a
  feature-detect guard, no new TOML npm dependency).
- Fixed the public installer launcher so new installs run the current
  `src/mind.ts` entry point.
- Fixed protocol wording and update flows that could confuse agent workflows
  during setup, migration, or session recovery.

## [1.4.0] - 2026-04-10

### Added

- `mind setup vscode` - VSCode support with platform-specific MCP config path
- `mind setup antigravity` - Antigravity support with L1 MCP wiring and skill installation at `~/.gemini/antigravity/`
- Skill installation for cursor, codex, windsurf, gemini-cli, vscode, antigravity

### Removed

- OpenClaw experimental agent (removed from capability matrix)
- Kiro roadmap agent (removed entirely from capability matrix)

### Changed

- MCP `space_get` now returns an orientation summary with overview counts,
  changed-at trending memories per tier, and plural `active_checkpoints` that
  reuse the `checkpoint_query` item shape.
- MCP memory payloads no longer expose `access_count` or `last_accessed_at`.
- Refactored internal MCP module layout so tool declarations stay in `src/mcp/tools/`, endpoint handlers/schemas are split into `src/mcp/handlers/` and `src/mcp/schemas/`, and shared MCP helpers now live under `src/mcp/helpers/` with no public contract change.
- MCP structured tools in stage 1 now emit a single raw YAML text item that is serialized directly from the structured payload, and `checkpoint_query` now includes an explicit `error` field for soft-error responses.
- MCP `memory_query.tier` now accepts `null` to mean “all tiers”, and the generated MCP input schema documents that behavior explicitly.
- MCP checkpoint responses now return full pending/linked-memory data without hidden truncation caps, and memory/checkpoint payloads now expose `changed_at` instead of `created_at` / `updated_at`.
- Restructured repository: moved cli/src to src/, cli/test to test/

- **Phase 1-6 Refactoring**: Major architectural refactor across phases 1-6:
  - **Phase 1**: `sqlite-store.ts` decomposed into 6 repositories in `cli/src/store/repositories/`: `SpaceRepository`, `MemoryRepository`, `LinkRepository`, `TagRepository`, `LogRepository`, `SearchRepository`. `sqlite-store.ts` now acts as a thin composition layer.
  - **Phase 3**: `setup.ts` consolidated — 5 duplicate agent-detection functions merged into 1 canonical helper. Setup flows for all agents now use shared infrastructure.
  - **Phase 4**: `memories.ts` MCP tool refactored with extracted helpers. Link transformation now uses shared `mapLinkedSummariesToLinksFormat()` from `link-building.ts`.
  - **Phase 5**: `checkpoint.ts` MCP tool refactored with extracted helpers for content building/fetching and linked memory formatting.
  - **Phase 6**: CLI `checkpoint.ts` refactored with extracted helpers for `--linked-memories` flag handling and recover response building.
  - Shared helpers created in `cli/src/helpers/`: `link-building.ts` and `checkpoint-content.ts`.
- **Phase 2**: Shared helpers for link-building and checkpoint content extraction in `cli/src/helpers/`:
  - `link-building.ts`: `buildLinkedMemoriesArray()`, `mapLinkedSummariesToLinksFormat()`, `transformLinkedSummary()`
  - `checkpoint-content.ts`: `buildCheckpointContent()`, `fetchCheckpointContent()`
  - MCP `checkpoint.ts` and CLI `checkpoint.ts` now delegate to shared helpers (DRY)
  - MCP `memories.ts` now uses `mapLinkedSummariesToLinksFormat()` for link transformation
- **Phase 6**: CLI `checkpoint.ts` refactored:
  - Extracted `linkMemoriesToCheckpoint()` helper for --linked-memories flag handling
  - Extracted `buildRecoverableCheckpoint()` helper for recover handler response building
  - `checkpoint set` handler uses `buildCheckpointContent()` (was already used) and `linkMemoriesToCheckpoint()`
  - `checkpoint recover` handler uses `buildLinkedMemoriesArray()`, `fetchCheckpointContent()`, and `buildRecoverableCheckpoint()`
  - Reduced CLI checkpoint.ts from 272 to ~283 lines (added helpers; net improvement in maintainability)
- All agents now use stdio transport (command + args) instead of HTTP (url)
- `mind setup claude-code` uses official `claude mcp add` CLI when available, falls back to `~/.claude/settings.json`
- `getMindScriptPath()` now finds bun in common locations ($HOME/.bun/bin, /usr/local/bin, etc.)
- MCP server config schema: `{type: "stdio", command: path, args: ["mcp"], env: {}}`

### Fixed

- Fixed repo-local path resolution for the web server static assets and `mind update` after the `src/` layout move, restoring SPA shell and asset loading.
- Claude Code MCP config schema (was causing "Does not adhere to MCP server configuration schema" error)
- Deep merge for claude-code fallback config (preserves existing config in ~/.claude/settings.json)

## [1.3.0] - 2026-04-06

### Changed

- **BREAKING**: `relatedRefs` in `checkpoint_save` renamed to `linked_memories` for consistency with other memory link naming.
- **BREAKING**: `checkpoint_load` response now returns `linked_memories` in memory_read format (enriched: name, space, ref, tier, tags, pinned, changed_at) instead of simple links array.
- Added `--linked-memories` flag to CLI `checkpoint set` command (comma-separated memory refs).

- Tier system simplified: T4 (frozen) removed, T3 now unlimited. All T4 memories automatically migrate to T3 on startup.
- **BREAKING**: `checkpoint_list` MCP tool renamed to `checkpoint_query` with extended filters (`from`, `to`, `tag`, `limit`, `offset`). Agents must update to use `checkpoint_query`.
- **BREAKING**: `search` MCP tool removed. Use `memory_query` with `search` parameter for full-text search instead.
- **BREAKING**: `checkpoint_done` now transforms the checkpoint into a session memory in `sessions/<repo>` and deletes the checkpoint. Previously it only marked the checkpoint as complete.
- **BREAKING**: CLI `checkpoint complete` now behaves identically to MCP `checkpoint_done` — transforms checkpoint into session memory in `sessions/<repo>` and deletes the original. Previously it only marked complete and demoted to T2.
- **BREAKING**: `links_to` in `memory_add` is now best-effort. The response includes `links_created` and `links_failed` arrays. Agents should check `links_failed` to see if any links couldn't be created.
- **BREAKING**: `checkpoint_load` lost the `agent` param and gained `checkpointName` param (optional, loads most recent active if omitted). Response stripped to `checkpoint` + `context_hits` only (no more capability_profile, degradation, guidance).
- **BREAKING**: `checkpoint_query` response now includes `goal` and `pending` preview fields for each checkpoint.
- **BREAKING**: `checkpoint_load` now requires `checkpointName` (no silent fallback to most recent). Agents must call `checkpoint_query` first to find available checkpoints, then `checkpoint_load` with the specific name. CLI `checkpoint recover` also requires `--checkpointName` flag; shows helpful error if omitted.
- **BREAKING**: `checkpoint_load` removed `includeHistory` and `format` parameters. Response no longer includes `context_hits`. Returns only `checkpoint` with `linked_memories` enriched.
- **BREAKING**: CLI `checkpoint recover` removed `--history` and `--format` flags. Output is always JSON checkpoint representation.

### Fixed

- Automatic schema migration from v6 to v7 on startup (idempotent, transaction-wrapped)

## [1.2.1] - 2026-03-27

### Fixed

- Fixed checkpoint recovery context rendering in Claude Code L3 hooks — newlines in recovered context are now properly escaped to prevent Markdown formatting issues.

## [1.2.0] - 2026-03-24

### MCP Redesign

- Reduced from 30 to 20 tools
- Tags now required on space.create and memory.add
- space.get returns hot_memories preview (T1 + T2)
- memory.read returns tier_change info
- memory.read and memory.get returned links_to and linked_by
- search with flexible parser (FTS5 → LIKE → embeddings fallback)
- memory.query unified listing (always includes T4)
- Unified memory reference: "space:name"
- checkpoint tools renamed: set→save, complete→done, recover→load
- Removed: space_rename, space_tag_add, space_tag_remove, memory_get_by_id, memory_list, memory_tag_add, memory_tag_remove, memory_tags_list, memory_patch, memory_promote, memory_demote, memory_pin, memory_unpin, links_list

### Changed

- memory_read now supports `noPromote:true` parameter for read-without-side-effects (replaces removed memory_get tool)
- Removed `memory_get` MCP tool (consolidated into `memory_read` with `noPromote:true`)
- search with flexible parser (FTS5 → LIKE → embeddings fallback)
- memory.query unified listing (always includes T4)
- Unified memory reference: "space:name"
- checkpoint tools renamed: set→save, complete→done, recover→load
- Removed: space_rename, space_tag_add, space_tag_remove, memory_get_by_id, memory_list, memory_tag_add, memory_tag_remove, memory_tags_list, memory_patch, memory_promote, memory_demote, memory_pin, memory_unpin, links_list

## [1.1.1] - 2026-03-13

### Fixed

- Fixed Neural Map left-click drag closing memory panel and deselecting memory — drag now behaves consistently with right-click drag (no close/deselect on drag release).
- Fixed Neural Map node click not opening side panel (regression from pointer capture).

## [1.1.0] - 2026-03-12

### Changed

- Replaced SSE streaming with polling for real-time logs in the web UI. Logs now update every 2 seconds via `/api/logs?since={lastLogId}` instead of EventSource SSE.

### Added

- Added operation logging system with SQLite storage, configurable retention (MIND_LOG_RETENTION_MINUTES, default 7 days), and automatic cleanup on startup and hourly.
- Added CLI, MCP, and API middleware to capture all operations with source, operation, level, input/output data, error messages, duration, and caller info.
- Added `GET /api/logs` endpoint with filtering by source, operation, level, search, date range, pagination, and ordering.
- Added `GET /api/logs/stream` endpoint for real-time log streaming via SSE.
- Added web UI for viewing and filtering logs in real-time (`/logs` route).

### Changed

- Added operation logging system capturing CLI, MCP, and API operations to SQLite `logs` table with configurable retention (default 7 days, configurable via `MIND_LOG_RETENTION_MINUTES`).
- Added `GET /api/logs` endpoint for querying logs with filters (source, operation, search, from/to, level, limit, offset, order).
- Added `GET /api/logs/stream` endpoint for real-time log streaming via Server-Sent Events (SSE).
- Added Logs page in web SPA (`/logs`) with source filters, text search, time ordering, live mode toggle, and expandable log details.
- Added automatic log cleanup on startup and hourly during operation.
- Added per-space graph API endpoint `GET /api/spaces/:space/graph` with minimal node payload (`id`, `name`, `tier`, `links_to`, `linked_by`), default T4 inclusion, and guardrail truncation metadata.
- Added Neural Map MVP view in the web SPA with concentric tier rings (T1..T4), pan/zoom controls, connectivity-based node prominence, and click-to-fetch memory details from the existing endpoint.
- Added graph behavior tests in `cli/test/api-routes.spec.ts` and `cli/test/mind-store.spec.ts`.
- Added MCP `memory_patch` as a bounded composite operation on one memory (`name/content`, `pinned`, bounded tier transition, tag add/remove, link add/remove) with explicit actionable validation errors and atomic all-or-nothing semantics.
- Added MCP `memory_add` support for optional `pinned` and `links_to_ids` with atomic all-or-nothing behavior when link validation fails.
- Added directional linked summaries to MCP `memory_read` response via `links_to` and `linked_by` fields with high-signal memory metadata (`id`, `name`, `changed_at`, `tier`, `tags`, `pinned`).

### Changed

- Changed web architecture to a single-server layout: `mind serve` now serves SPA files from the reorganized `web/` tree (`web/src`, `web/styles`, `web/assets`, `web/public`) via canonical `cli/src/api/server.ts`.
- Changed web frontend runtime to modular ES modules without a build pipeline, with `@ts-check` + JSDoc typing in key modules.
- Changed web index asset/module paths to deep-route-safe root-absolute URLs (`/assets/*`, `/styles/*`, `/src/*`).
- Changed test organization so web-only tests run from `web/test` while backend/CLI suites remain in `cli/test`.
- Changed root test commands to include both suites by default (`bun test cli/test web/test`) and added web-only commands (`bun test web/test`, `make test-web`).
- Changed web SPA navigation to be URL-driven for space/view/memory (`/`, `/spaces/{space}?view=list|map&memory={memory}`), including reload restore, browser back/forward support, and safe fallback canonicalization for invalid route state.
- Changed web SPA memory detail behavior to close the panel on outside click/tap while preserving in-panel interactions and memory selection from list/map.
- Changed space detail UI to include a `List` / `Neural Map` toggle while preserving existing list/detail behavior.
- Changed Neural Map interactions to use anchor-aware zoom math (wheel at pointer, buttons at map center) and clamped zoom-responsive label sizing without API changes.
- Changed Neural Map readability for dense spaces by truncating visible node labels to 25 characters plus ellipsis (full names preserved via accessibility/tooltip), increasing max zoom ceiling, and applying deterministic bounded best-effort overlap mitigation in ring layout.
- Changed MCP system instructions/protocol wording to explicitly require linking directly relevant memories for recovery continuity and to state atomic all-or-nothing semantics for composite memory operations.
- Changed MCP tool schema conversion to preserve array item types (`number[]`, `boolean[]`, `string[]`) in generated JSON Schema.

### Fixed

- Fixed Neural Map drag UX by preventing text selection/touch scrolling while panning the graph surface.
- Fixed Neural Map right-click behavior so right-button drag pans the graph, quick right-click keeps the browser context menu, and quick right-click no longer triggers node selection.

### Removed

- Removed legacy `web/server.ts`; the only supported web server path is `cli/src/api/server.ts` (invoked by `mind serve`).

## [1.0.0] - 2026-03-09

### Added

- Added strict template renderer regression tests in `cli/test/template-renderer.spec.ts` to fail on unresolved placeholders/conditionals and leftover template tokens.
- Added snapshot coverage for rendered protocol outputs: per-agent memory protocol snapshots and system instructions snapshot (`cli/test/snapshots/*`).
- Added MCP `system_instructions` contract stability tests to lock tool key, payload acceptance shape, and `instructions_version` response semantics.
- Added stronger setup hardening tests for dirty reruns (managed block/hook dedupe, instruction list cleanup, and legacy protocol file guardrails).

- Added Cursor global L3 setup automation in `mind setup cursor`, writing managed idempotent hooks entries in `~/.cursor/hooks.json` and managed executable script artifacts in `~/.cursor/hooks/` with non-blocking fallback messaging.
- Added Codex global L2 managed protocol injection in `mind setup codex` by non-destructively upserting a managed block in `~/.codex/AGENTS.md`.
- Added setup regression coverage for Cursor/Codex idempotency and non-destructive behavior, including managed hooks/script artifacts and managed AGENTS.md block upsert checks.
- Added shared capability metadata module (`cli/src/cli/capabilities.ts`) so setup matrix output and recovery flows reuse the same L1/L2/L3 status/confidence/evidence/fallback declarations.
- Added integrated Recovery Pack generation for `checkpoint recover` (CLI + MCP) with `format` support (`text|md|json`) and capability-aware degradation guidance.
- Added checkpoint recovery tests covering format coherence (`text|md|json`), no-active-checkpoint guidance, and capability-profile fallback payloads.
- Added deterministic hybrid retrieval regression tests for weighted FTS+semantic ranking and semantic threshold fallback when FTS has no hits.
- Added a README agent status matrix (`Complete` / `Partial` / `Experimental` / `Roadmap`) mapped directly to current L1/L2/L3 capability declarations.
- Added capability-driven setup adapters for agent integrations with explicit L1/L2/L3 declarations (`supported`/`unsupported`/`unverified`) plus confidence/evidence/fallback diagnostics.
- Added default-on, non-blocking OpenCode prudent automation setup that writes a managed plugin (`~/.config/opencode/plugins/mind-automation.js`) with session start scaffolding, compaction continuity hooks, and prudent session summaries with deterministic anti-noise caps.
- Added setup capability diagnostics coverage in `cli/test/setup-capabilities.spec.ts`, including explicit Cursor `unverified` assertions for L2/L3 and fallback visibility checks.
- Added checkpoint system for session persistence and recovery:
  - `checkpoint set` / `cp set` - Create/update a checkpoint
  - `checkpoint complete` / `cp complete` - Mark checkpoint as completed
  - `checkpoint recover` / `cp recover` - Recover latest active checkpoint
  - `checkpoint list` / `cp list` - List all checkpoints for a space
- Added hidden spaces feature:
  - `mind update <space> --hidden` - Mark space as hidden
  - `mind update <space> --no-hidden` - Unmark space as hidden
  - `mind list --hidden` - Show hidden spaces
- Added MCP checkpoint tools: `checkpoint_set`, `checkpoint_complete`, `checkpoint_recover`, `checkpoint_list`
- Added checkpoint space organization: `<space>:sessions` for storing checkpoints
- Added regression coverage for protocol-resource wiring in setup and MCP system tools: `cli/test/setup-opencode.spec.ts` and `cli/test/system-tools.spec.ts`.
- Added **experimental** capability declaration for `openclaw` as status-only output (`L1 unverified`, `L2/L3 unsupported`) with explicit fallback diagnostics and no setup wiring.
- Added Claude setup hardening coverage in `cli/test/setup-capabilities.spec.ts` for non-destructive reruns, managed block idempotency, and opt-in hook stability/idempotency.
- Added Gemini CLI and Windsurf setup capability regression assertions to keep evidence-based fallback diagnostics and avoid silent L2/L3 upgrades.

### Changed

- Changed template rendering to strict-fail unresolved placeholders/conditionals for all render paths (setup protocol rendering and MCP `system_instructions` rendering).
- Changed setup reruns to self-heal dirty state by deduplicating managed protocol blocks/hook entries and sanitizing duplicate instruction paths.
- Changed setup flows to remove known legacy per-agent protocol files when applying managed protocol wiring.

- Changed setup L2 protocol generation for OpenCode, Claude Code, and Codex to render from one canonical template source with a minimal internal renderer, preserving existing idempotent and non-destructive managed-file behavior.
- Refactored MCP `system_instructions` to render via the canonical internal template pipeline while preserving `instructions_version` (`1.1.0`) and response payload compatibility.

- Changed search ranking (with RAG enabled) to deterministic weighted normalized hybrid scoring over FTS rank + semantic similarity, while keeping FTS-only behavior compatible when RAG is disabled.
- Changed `checkpoint recover` to remain the single recovery interface while adding Recovery Pack output and explicit capability-profile communication for degraded orchestration paths.

- Changed OpenClaw capability declaration from roadmap wording to explicit **experimental** status with stronger fallback diagnostics and no setup wiring overclaims.
- Changed README agent status labels from Spanish to English and improved status table header emphasis for clearer scanability.

- Added `mind update <space> --description|--hidden|--no-hidden` for explicit space updates.
- Spaces now have a `hidden` field (default: false)
- Added MCP setup, process management, and detached runtime commands.
- Added one-line installer (`scripts/install.sh`) for user-local installation.
- Added self-update command (`mind update`) from GitHub releases.
- Added maintainer release automation scripts and Make targets (`release-patch`, `release-minor`, `release-major`, `release-simulate`).
- Added `mind query` (`query|q`) to filter memories by space/tag/tier/date with pagination.
- Added API endpoint `GET /api/memories/query` for metadata/date memory queries.
- Added MCP `memory_query` tool with metadata/date filters and offset pagination (`nextOffset`).
- Changed `mind setup opencode` to be explicitly idempotent/non-destructive with deep-merge JSON behavior and managed Memory Protocol instruction injection.
- Changed `mind setup opencode` MCP transport wiring from remote HTTP URL to OpenCode-compatible local command transport (`type: "local"`, `command: ["<path-to-mind>", "mcp"]`).
- Hardened `mind setup opencode` to place the managed `~/.config/opencode/instructions/mind-memory-protocol.md` path as the first `instructions` entry (exact path, deduplicated), and updated the managed protocol text to explicitly require calling `mind_system_instructions` before tool usage.
- Changed `mind setup codex` MCP args to local stdio command mode (`args = ["mcp"]`) instead of forcing HTTP start flags.
- Changed `mind setup claude-code` to inject a managed protocol file plus managed block in `~/.claude/CLAUDE.md`, keeping setup idempotent/non-destructive.
- Added opt-in, non-blocking Claude L3 hook automation behind `MIND_SETUP_CLAUDE_ENABLE_HOOKS=true`, with explicit safe fallback messaging when disabled or unsupported.
- Added roadmap capability declarations (`vscode`, `antigravity`) to setup matrix output as status-only entries (no setup wiring).
- Refactored embedded protocol markdown into canonical files under `cli/src/resources/protocols/` and added shared loader `cli/src/helpers/markdown-resource.ts` for OpenCode/Claude setup injection and MCP `system_instructions` content.
- Changed `mind setup` matrix listing output to print full per-level status/confidence/evidence/fallback lines for each adapter (not only summarized statuses).

### Changed

- Reorganized source layout into explicit domains: `cli/`, `mcp/`, `api/`, `helpers/`.
- Refactored CLI command handling into atomic modules loaded by a registry-based command executor.
- Split HTTP API into route modules plus centralized router matcher.
- Rewrote README for open-source onboarding and modern install/update workflow.
- Changed memory list/read/search/query output to use consistent changed-date display for better recency visibility.
- Changed `mind query` default page size to 25 and added inline pagination footer (`limit | offset | next offset`).
- Added semantic `changed_at` tracking for memories and switched CLI/API date displays and query date filters/order to use `changed_at` (excluding read/access and embedding updates).
- Unified date rendering in CLI memory outputs (`list`, `read`, `search --detail`, `query`) to a shared changed-date format and improved `search/query` help flag descriptions with expected values/formats.
- Changed shared memory reference rendering in CLI lists/search/query to bracketed format (`[Space] / [Memory]`) for faster visual scanning.
- Changed MCP call-tool responses to include structured payload data (when provided by tool handlers), not only text content.
- Increased Bun HTTP idle timeout defaults to reduce premature request timeouts (`MIND_MCP_IDLE_TIMEOUT` default 120s, `MIND_API_IDLE_TIMEOUT` default 30s).

### Fixed

- Fixed command wiring inconsistencies between runtime entrypoint and subcommand modules.
- Improved detached startup behavior with process liveness checks and clearer failure messages.
- Fixed MCP tools not receiving parameters: corrected Zod to JSON Schema conversion for Zod 4.x in `cli/src/mcp/server.ts`
- Added MCP annotations (`readOnlyHint`, `destructiveHint`, `idempotentHint`) to all 29 MCP tools
- Added defensive validation with clear error messages to all MCP tool handlers
- Replaced ad-hoc MCP HTTP handling with the official Streamable HTTP transport implementation (session-aware initialize/tools flow), fixing Cursor connection errors (`Unknown method`, SSE fallback 404).
- Fixed TypeScript build stability under `verbatimModuleSyntax`: narrowed unknown Zod shape entries in MCP schema conversion, corrected `web/server.ts` tag helper import path, and replaced direct `bun-style` imports with a local style helper using type-only `ansi-styles` imports.
