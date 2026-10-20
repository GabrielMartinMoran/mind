# Cognitive memory lifecycle: implementation report

This report records the implementation of feature
`00010-cognitive-memory-lifecycle` on the `develop` branch and the real-agent
validation that followed. It separates what was measured from what was not.
The companion reference is
[`docs/cognitive-memory-lifecycle.md`](cognitive-memory-lifecycle.md); the
canonical agent instructions are
[`src/resources/protocols/mind-cognitive-protocol.md`](../src/resources/protocols/mind-cognitive-protocol.md).

## Summary

Mind now exposes a coherent cognitive lifecycle across its search, MCP, and
protocol surfaces:

- Semantic matches are admitted independently of lexical results, while RAG
  remains optional and off by default.
- `memory_update` supports atomic pinning and explicit tier transitions.
- Links carry real labels and direction, and checkpoint navigation is fixed.
- `space_get` returns living references and bounded T3 availability.
- A single canonical protocol body drives the L2 template, MCP
  `system_instructions`, and the installed skill.
- Six paid OpenCode scenarios (B5–B10) validate durable writing, relinking,
  supersession, tier maintenance, cross-session continuity, and semantic
  recall against isolated databases.

No scenario or test opened the live user database; every paid run used its own
isolated database. The only live-database writes were the session's own
memory/checkpoint updates. The full test suite, harness tests,
typecheck, lint, and format checks passed.

## What changed by workstream

### Semantic admission

Semantic candidates previously passed through the same lexical admission gate
as lexical candidates. When at least one lexical result existed, a purely
paraphrased match was discarded. The new admission policy separates the two:

- `src/store/shared/semantic-admission.ts` defines
  `SEMANTIC_ADMISSION_FLOOR = 0.6`, `canBypassLexicalAdmission`, and
  `selectSemanticAdmittedIds`.
- The bypass applies only to natural-language queries: one positive group, no
  `NOT`, and only plain terms. Explicit phrases, prefixes, `OR`, `AND`, and
  `NOT` stay on the lexical path.
- The search repository keeps lexical rows separate from the combined row set.
  `token_set` is computed on lexical rows only, then semantic-only candidates
  are admitted after the lexical ladder.
- RAG-off behavior stays byte-identical. Space, tier, and tag filters and `NOT`
  exclusions apply to semantic candidates. An open embedding breaker admits
  nothing.

### Memory maintenance

`memory_update` now accepts `pinned` and `tierTransition` in addition to
rename, content, and tags. The handler normalizes and diffs tags before opening
one atomic `patchMemory` call. Empty updates return the existing memory for
compatibility. A failed tier transition or invalid tag leaves the memory
unchanged.

### Links and navigation

Linked summaries now include `label` and `direction` (`outgoing` or
`incoming`). The shared helper resolves the correct other endpoint, avoids
self-inclusion, and applies the limit after filtering. `getLinks` has a
deterministic order. Relabeling is documented as a repeated `link_create` on
the same directed pair, and `link_delete` is documented as an idempotent no-op.
Checkpoint recovery no longer includes the checkpoint itself through an
incoming link.

### Space orientation

`space_get` returns a `references` block for living references alongside the
existing overview, tier previews, and active checkpoints. Trending and
reference queries use SQL limits and counts, so T3 is represented by a bounded
preview plus total availability instead of a full scan. Results are ordered
pinned-first where applicable.

### Canonical protocol

The protocol is a single token-free body in
`src/resources/protocols/mind-cognitive-protocol.md`, organized as ORIENT,
RECALL, LEARN, RELATE, MAINTAIN, and HANDOFF. Thin wrappers render it into the
L2 agent template, MCP `system_instructions`, and the installed
`mind-management` skill. Protocol version moved to `2.0.0`. The protocol teaches
inspection versus active use, replace semantics for tags, supersession,
link labels and direction, tier and pin behavior, living references, and
handoff.

### Benchmark

The agent-memory harness gained a `mind-current` condition that runs the local
checkout against an isolated database, per-scenario `MIND_RAG` control,
credential loading without artifact leakage, read-only database inspection
helpers, and `not_run` gating when a required capability is missing. Scenarios
B5 through B10 cover the lifecycle behaviors.

## Files changed

The change spans the following areas. Paths are representative rather than an
exhaustive diff.

| Area               | Paths                                                                                                                                                                                                                                                                                                                                                    |
| ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Semantic admission | `src/store/shared/semantic-admission.ts`, `src/store/repositories/search-repository.ts`, `test/search-semantic-admission.spec.ts`                                                                                                                                                                                                                        |
| Memory maintenance | `src/mcp/schemas/memories/update-memory.ts`, `src/mcp/handlers/memories/update-memory.ts`, `src/mcp/tools/memories.ts`, `src/store/mind-store.ts`, `src/store/repositories/memory-repository.ts`                                                                                                                                                         |
| Links              | `src/helpers/link-building.ts`, `src/store/repositories/link-repository.ts`, `src/checkpoint/recovery-pack.ts`, `src/mcp/tools/links.ts`, `src/mcp/tools/memories.ts`                                                                                                                                                                                    |
| Space orientation  | `src/mcp/helpers/space-orientation.ts`, `src/mcp/handlers/spaces/get-space.ts`, `src/store/repositories/search-repository.ts`                                                                                                                                                                                                                            |
| Protocol           | `src/resources/protocols/mind-cognitive-protocol.md`, `src/resources/protocols/mind-memory-protocol.template.md`, `src/resources/protocols/mind-system-instructions.md`, `src/resources/skill-mind-management.md`, `src/cli/memory-protocol.ts`, `src/cli/system-instructions.ts`, `src/cli/mind-management-skill.ts`, `src/setup/skill-installation.ts` |
| Benchmark harness  | `benchmarks/agent-memory/src/benchmarkB/*`, `benchmarks/agent-memory/src/isolation/opencode.ts`, `benchmarks/agent-memory/src/mind/inspect.ts`, `benchmarks/agent-memory/src/config.ts`, `benchmarks/agent-memory/fixtures/b5..b10/**`, `Makefile`                                                                                                       |
| Tests and specs    | `test/*.spec.ts`, `web/test/*.spec.ts`, `specs/features/**/*.feature`                                                                                                                                                                                                                                                                                    |
| Documentation      | `docs/cognitive-memory-lifecycle.md`, `docs/cognitive-memory-lifecycle-report.md`, `AGENTS.md`, `CLAUDE.md`, `README.md`, `CHANGELOG.md`                                                                                                                                                                                                                 |

The Gherkin feature files are owned by the Lead and were updated in their own
tasks. This documentation task did not change them.

## Skills used

- `prompt-optimizer` — protocol content was reduced to the minimum effective
  form, with decision tables and a compact appendix.
- `cognitive-writing` — the reference and report use an inverted-pyramid order,
  descriptive headings, and scan-friendly sections.
- `docs-writer` — documentation standards, relative links, and link validation.
- `clean-code` — naming, small units, and removal of duplicated logic.
- `clean-architecture` — layer boundaries and dependency direction.
- `clean-backend-architecture` — handler, store, and tool boundaries.
- `bun-development` — Bun runtime, tests, and scripts.
- `opencode` — isolated OpenCode sessions for benchmark execution.
- `mind-management` — used by the Lead for durable project memory.

## New capabilities

- Paraphrased queries can retrieve a semantic match even when lexical results
  exist, without changing RAG-off behavior.
- `memory_update` can pin, unpin, promote, and demote atomically with content
  and tag updates.
- `memory_read` shows each direct relation's label and direction.
- `space_get` orients an agent with living references and T3 availability.
- Agents receive one consistent protocol across setup, MCP, and the skill.
- The benchmark harness can run the current checkout against isolated
  databases with per-scenario RAG control.

## Tests executed

| Check              | Command                        | Result                    |
| ------------------ | ------------------------------ | ------------------------- |
| Full suite         | `bun test test/ web/test`      | 1278 pass, 7 skip, 0 fail |
| Harness suite      | `make bench-agent-memory-test` | 365 pass, 7 skip, 0 fail  |
| Search experiments | experiment suites              | 105 pass                  |
| Typecheck          | `bun run typecheck`            | pass                      |
| Lint               | `bun run lint`                 | pass                      |
| Format             | `bun run format:check`         | pass                      |

The counts above are from the validated implementation run. This documentation
task re-ran the full suite, typecheck, lint, and format check after its edits.

## Real-agent validation (D12)

Paid validation ran on the `mind-current` condition with isolated databases,
using `openrouter` and `deepseek/deepseek-v4.1-flash`, under an authorized
budget cap of USD 5. Each run uses its own fresh database and workspace copy.

| Scenario                              | Sessions | Result | Cost (USD) | Run                        |
| ------------------------------------- | -------- | ------ | ---------- | -------------------------- |
| B5 durable writing                    | 2        | PASS   | 0.0039279  | `run-20261020-012612-6bfb` |
| B6 relinking                          | 2        | PASS   | 0.0020434  | `run-20261020-012612-6bfb` |
| B7 decision change / supersession     | 2        | PASS   | 0.0028105  | `run-20261020-012612-6bfb` |
| B8 tier maintenance / pinning         | 2        | PASS   | 0.0014654  | `run-20261020-012612-6bfb` |
| B9 cross-session continuity (initial) | 3        | FAIL   | 0.0115392  | `run-20261020-012612-6bfb` |
| B9 cross-session continuity (rerun)   | 3        | PASS   | 0.0042280  | `run-20261020-014241-8765` |
| B10 semantic recall                   | 1        | PASS   | 0.0006431  | `run-20261020-013555-a01d` |

The first B9 run failed because of a scenario-design bug, not a product defect.
The assertion required the session summary to remain at T3 after a
`memory_read`, but reading a memory auto-promotes it (T3 → T2 → T1) and a
`checkpoint_done` summary is a normal memory that participates in promotion. In
addition, the first version required the literal string `bun`, although the
task only asked for the version. The scenario was corrected to accept a
fact-bearing session summary at any tier and to require the fact `1.3`. The
paid rerun passed: `continuity.txt` carried the preserved fact `1.3`.

B10 passed with `recall.txt` containing:
"Release credentials (cryptographic keys) are renewed every 24 hours."

Budget accounting:

- B5–B9 first run: USD 0.0217863.
- B10: USD 0.0006431.
- B9 rerun: USD 0.0042280.
- Cumulative: USD 0.026657 of the USD 5 cap (the three run totals above).

Safety checks:

- `data/mind.db` had the same sha256 before and after the harness run window.
- No credentials or API keys appear in the committed artifacts.
- Each scenario used an isolated database and workspace.

## Improvements observed

- The five lifecycle behaviors that were not blocked by the scenario bug
  passed on the first paid run (B5, B6, B7, B8, and B10), and B9 passed after
  the scenario fix.
- B6 confirmed that relabeling with `link_create` replaces the old label:
  `checkout-implementation → checkout-strategy [implements]`, with the old
  `related` label gone.
- B7 confirmed supersession preserved the historical decision, added
  `status:superseded`, kept `cat:decision`, and stored the `contradicts` link.
- B8 confirmed the release checklist reached T1, was pinned, and left
  background notes at T2 unpinned.
- B10 produced a paraphrase recall: the prompt shared no content words with the
  target memory, and the answer recovered the target fact.
- No scenario or test opened the live database, and no secrets leaked into
  artifacts. The session's own memory/checkpoint updates were the only
  live-database writes.

## Limitations and pending work

- **B10 is outcome-only.** The scenario proves the agent recovered the
  paraphrase; it does not prove the agent used the semantic channel. The agent
  could enumerate the small isolated space and find the memory lexically. The
  assertion checks that the target memory has an embedding, but it does not
  assert that the semantic channel produced the result.
- **B10 seed embedding cost is not counted.** `BudgetGuard` does not account
  for the embedding generated when seeding the target memory.
- **Single run per scenario.** There are no repeated trials or baselines, so
  the results show feasibility, not a measured improvement over an alternative
  condition.
- **B8 does not gate on tier maintenance for historical v9/v10 conditions.**
  The scenario validates the current condition.
- **CLI memory references cannot reach nested spaces.** `parseMemoryRef` splits
  `space/name` at the first slash, so `projects/mind` cannot be expressed on
  the CLI `link`/`unlink` path. Use the MCP `link_create` and `link_delete`
  tools with `space:name` references.
- **RAG remains off by default.** Semantic admission only applies when RAG is
  enabled with a provider key.
- **No commit was made by this task.** The working tree remains for review.

## Measured versus not measured

Measured:

- B5–B10 scenario pass/fail and cost, from real OpenCode sessions on isolated
  databases.
- `data/mind.db` sha256 unchanged across the harness run window.
- Full test suite, harness suite, experiment suites, typecheck, lint, and
  format results.
- The B10 outcome: a paraphrase-only answer was recovered.
- The specific B6, B7, and B8 database states asserted by the harness.

Not measured:

- Whether B10 used the semantic channel rather than enumeration.
- Semantic recall quality on a larger corpus or against a lexical baseline.
- The embedding cost of benchmark seeding.
- Repeat-run variance or statistical significance.
- Whether the protocol changes improve agent behavior beyond the six
  scenarios.
- A live-database migration or production rollout; none was performed.

## Recommendation

The feature meets its implementation and validation goals for the current
scope. Continue with final QA. Treat B10 as a feasibility result, not as proof
of semantic-channel usage, and keep RAG off by default until a larger,
channel-attributed evaluation exists.

## Related documentation

- [`docs/cognitive-memory-lifecycle.md`](cognitive-memory-lifecycle.md)
- [`src/resources/protocols/mind-cognitive-protocol.md`](../src/resources/protocols/mind-cognitive-protocol.md)
- [`docs/memory-recall-improvement-analysis.md`](memory-recall-improvement-analysis.md)
- [`docs/search-benchmarks.md`](search-benchmarks.md)
- [`docs/search-optimization-report.md`](search-optimization-report.md)
- [`benchmarks/agent-memory/README.md`](../benchmarks/agent-memory/README.md)
