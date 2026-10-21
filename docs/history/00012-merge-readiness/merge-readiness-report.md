> **Historical report for feature 00012-merge-readiness.** Frozen on 2026-10-20.
> Current behavior: [Skill-first distribution](../../skill-first-distribution.md).

# Merge-readiness report

This report covers feature `00012-merge-readiness` on
`feat/cognitive-memory-lifecycle-and-associative-recall`. It records the
scoped corrections from D1–D4, the files they touched, the verification that
ran locally, and the behavior that remains unverified. It does not claim a
redesign, new memory features, or a completed GitHub CI run.

The scope was documentation and hardening only: exact-name skill installation,
one Bun lockfile, deterministic CI, atomic checkpoint completion, and a free
OpenCode discovery check. No production search, schema, tool, or Gherkin
changes were made.

## 1. Corrections

- **D1 — exact-name skill installation.** Only `mind-management` in an
  explicit Mind-managed location is installed or updated. Same-name content
  there is updateable with or without the ownership marker; the marker is
  provenance, not authorization. Historical signature heuristics were removed,
  and unrelated skills are never modified.
- **D1 — portable file safety.** Updates back up the previous `SKILL.md`,
  preserve auxiliary files, record a foreign or broken symlink as
  `LINK_TARGET=<target>` in a sidecar backup, and replace the link without
  writing through it. A non-directory managed path is repaired instead of
  raising `ENOTDIR`. Detection uses `lstat`, and copy fallback plus Windows
  junction behavior keep the nine supported clients working.
- **D2 — atomic checkpoint completion.** `MindStore.completeCheckpoint` now
  performs the summary insert, inbound and outbound link copy, and checkpoint
  delete in one synchronous SQLite transaction. A failure in any step rolls
  back the whole transformation, so a retry cannot duplicate a summary or lose
  links. The embedding request runs after the commit, and auto-export runs once.
- **D3 — one lockfile and honest CI.** Root `package-lock.json` was removed;
  `bun.lock` is the only root lockfile, and the release script no longer handles
  npm locks. CI uses `bun run format:check`, `bun run typecheck`, Bun 1.3.14, and
  frozen root and benchmark installs. The audit step was removed rather than
  suppressed because `bun audit --audit-level=high` fails on real advisories.
- **D4 — free OpenCode validation.** A gated, no-model integration test installs
  the canonical skill in a temporary home and checks skill discovery, the brief
  L2 instruction, MCP configuration and handshake, `/api/skill` polling, and
  the isolation allowlist. Paid B11 was prepared but not run.

## 2. Files changed

The working tree is intentionally uncommitted for review.

| Area                 | Files                                                                                                                                                                                                                                                                        |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Skill installation   | `src/setup/skill-installation.ts`, `src/cli/setup.ts`, `test/skill-installation.spec.ts`                                                                                                                                                                                     |
| Checkpoint atomicity | `src/store/mind-store.ts`, `src/store/repositories/memory-repository.ts`, `src/store/sqlite-store.ts`, `src/sync/auto-export-store.ts`, `src/checkpoint/checkpoint-done.ts`, `test/checkpoint-atomicity.spec.ts`, `test/sync-autosync-redesign.spec.ts`                      |
| Lockfile and CI      | `.github/workflows/main.yml`, `package-lock.json` (deleted), `scripts/release.sh`, `test/release-script.spec.ts`, `test/ci-workflow.spec.ts`                                                                                                                                 |
| OpenCode validation  | `benchmarks/agent-memory/test/skill-discovery.integration.spec.ts`, `benchmarks/agent-memory/src/benchmarkB/scenarios/b11/`, `benchmarks/agent-memory/fixtures/b11/`, `benchmarks/agent-memory/test/benchmarkB-b11.spec.ts`, benchmark runner/scenario/worker/registry files |
| Specification        | `specs/features/product/merge-readiness.feature`                                                                                                                                                                                                                             |
| Documentation        | this report, `docs/skill-first-distribution.md`, `docs/skill-first-distribution-report.md`, `docs/agent-integration-matrix.md`, `AGENTS.md`, `README.md`, `CHANGELOG.md`, `benchmarks/agent-memory/README.md`                                                                |

## 3. Exact-name skill installation

The installer no longer scans content for historical signatures. A file is
managed when it is `mind-management` in a known managed location. This keeps an
old copy updateable even when it has no current marker, while preventing a
same-named file elsewhere from being touched.

The install contract is:

- Install when absent and leave byte-identical content untouched.
- Back up and replace only `SKILL.md` when the bytes differ; keep extras.
- Classify paths with `lstat`, never following a symlink to read or write
  external content.
- Replace foreign or broken symlinks and record the old target.
- Repair a non-directory managed path with a backup instead of failing.
- Fall back to a managed copy when linking is unavailable.
- Use a directory junction on Windows; that path remains statically tested.

All nine supported clients resolve the skill from their documented path and no
other skill is modified.

## 4. package-lock resolution

The root repository had a stale `package-lock.json` with no real consumer.
CI, Docker, the release script, and local development already use Bun. The file
was removed, and the release script no longer reads, writes, or aligns npm-lock
versions.

Root and benchmark installs now stay isolated. The root has no
`@opencode/sdk`; the benchmark owns `@opencode/sdk@2.0.28` and its own
`bun.lock`. Both projects install with `--frozen-lockfile`.

## 5. CI fixes

CI previously combined `bun run format --check` with an npx fallback. The
`format` script writes files, so the check could rewrite instead of detecting
drift. It also suppressed audit failures with `npm audit || true`.

The workflow now runs `bun run format:check`, `bun run typecheck`, lint, and the
root test suite in the `validate` job. The benchmark job runs its own frozen
install, typecheck, unit and contract tests, and experiment tests. Both pin Bun
1.3.14 and neither runs a paid stage.

The audit step is absent by design. On 2026-10-20,
`bun audit --audit-level=high` reported 27 advisories in the root (1 critical,
26 high; 14 production = 1 critical, 13 high) and 2 high in the benchmark.
Dependency upgrades are a separate follow-up. The workflow comment records the
date and numbers; failures are not hidden with `|| true` or
`continue-on-error`.

**Important distinction:** CI has not run on GitHub for this branch. Only local
static workflow checks, the TypeScript checks, and the test suites ran. A green
local result does not prove a green GitHub run.

## 6. Checkpoint atomicity guarantees

`checkpoint_done` previously created the summary, copied links in a loop with
an empty `catch`, and then deleted the checkpoint. A link failure lost a
relation, and a delete failure could leave both the summary and the checkpoint,
so a retry duplicated the summary.

Completion now has these guarantees:

- **All-or-nothing.** Summary creation, every inbound and outbound link copy
  with its label and direction, and checkpoint deletion commit together.
- **Rollback on any failure.** A forced summary, link, or delete failure leaves
  the checkpoint in place, creates no partial summary, and preserves the
  original links.
- **Safe retry.** After the failure is removed, one retry creates exactly one
  summary, preserves every relation, and deletes the checkpoint.
- **Post-commit side effects.** The embedding request runs after the commit, and
  auto-export runs once.

The MCP and CLI surfaces are unchanged.

## 7. Test results

These are local results on 2026-10-20. No paid test ran and no live database was
opened.

| Check                     | Command                                                                 | Result                    |
| ------------------------- | ----------------------------------------------------------------------- | ------------------------- |
| Root suite                | `bun test test/ web/test`                                               | 1386 pass, 8 skip, 0 fail |
| Benchmark suite           | `cd benchmarks/agent-memory && bun test test`                           | 388 pass, 8 skip, 0 fail  |
| Benchmark experiments     | `cd benchmarks/agent-memory && bun test experiments`                    | 105 pass                  |
| Free OpenCode integration | `BENCH_INTEGRATION=1 bun test test/skill-discovery.integration.spec.ts` | 1 pass                    |
| Root typecheck            | `bun run typecheck`                                                     | Pass                      |
| Root lint                 | `bun run lint`                                                          | Pass                      |
| Root format               | `bun run format:check`                                                  | Pass                      |
| Root frozen install       | `bun install --frozen-lockfile`                                         | Pass                      |
| Benchmark frozen install  | `cd benchmarks/agent-memory && bun install --frozen-lockfile`           | Pass                      |

The integration count is included in the benchmark suite count. Benchmark
experiments are a separate `bun test experiments` run.

## 8. Skill-first real validation status

The free validation is real but narrow. It uses OpenCode 2.0.28 with
`BENCH_INTEGRATION=1` and no model or provider call. It proves that setup
installs the canonical skill and brief L2 activation, that OpenCode config and
the MCP handshake expose the activation, that `/api/skill` discovery lists
`mind-management`, and that the isolation allowlist accepts the installed
skill.

B11 is prepared and gated but **not run**. It defines two sessions: the first
loads the skill, uses a Mind tool, avoids `system_instructions`, and leaves a
pending checkpoint; the second resumes the pending work and writes `resume.txt`.
Its assertions check the raw transcript for a `skill` call with id
`mind-management`, at least one Mind tool call, no `system_instructions` call
after the skill load, a surviving pending checkpoint, and the resume artifact.

Live model behavior remains unverified: that a real model actually loads the
skill before acting, follows the protocol instead of the fallback, and keeps
the checkpoint across sessions. `OPENCODE_DISABLE_AUTOCOMPACT=1` also prevents
compaction validation today. Live clients other than the free OpenCode check
remain unverified.

## 9. Pending and limitations

- **GitHub CI not run.** Local workflow assertions pass; the hosted workflow
  remains unexecuted for this branch.
- **Dependency advisories open.** The audit step is intentionally absent. Root
  and benchmark dependency upgrades remain a separate follow-up.
- **Paid B11 not run.** No model/provider call was authorized, so live skill
  activation, protocol use, and cross-session continuity remain unverified.
- **Compaction unverified.** `OPENCODE_DISABLE_AUTOCOMPACT=1` prevents a
  compaction test today.
- **Other live clients unverified.** Cursor L3 payload/argv/execution, Pi
  extensions, and live activation for Windsurf/Devin, VS Code/Copilot,
  Antigravity, and Gemini CLI were not tested.
- **Windows junction static only.** The junction path is covered by static and
  unit checks, not a live Windows run.
- **Working tree uncommitted.** This documentation task created no commit.

## Before and after

| Area                  | Before                                                               | After                                                                                    |
| --------------------- | -------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| Skill update policy   | Signature heuristics decided whether an old copy was managed         | Exact name in a managed path is updateable; marker is provenance; other skills untouched |
| Root lockfile         | Stale `package-lock.json` plus `bun.lock`                            | `bun.lock` only; no npm-lock code in the release script                                  |
| CI format             | `bun run format --check` with an npx fallback that could write       | `bun run format:check` only                                                              |
| CI audit              | `npm audit` followed by a shell no-op hid failures                   | No audit step; workflow documents the real advisory counts and a separate follow-up      |
| Checkpoint completion | Summary + best-effort links + delete, with partial states on failure | One synchronous transaction for summary, links, and delete; rollback and safe retry      |
| OpenCode validation   | Skill discovery in the current build not re-validated                | Free discovery/config/handshake validated; paid B11 prepared and not run                 |

## Verification commands

Local only:

```sh
bun run format:check
bun run lint
bun run typecheck
bun test test/ web/test
cd benchmarks/agent-memory
bun test test
bun test experiments
```

## Related documentation

- [Merge-readiness Gherkin contract](../../../specs/features/product/merge-readiness.feature)
- [Skill-first distribution](../../skill-first-distribution.md)
- [Skill-first implementation report](../00011-skill-first-distribution/skill-first-distribution-report.md)
- [Agent integration matrix](../../agent-integration-matrix.md)
- [Agent memory benchmark](../../../benchmarks/agent-memory/README.md)
