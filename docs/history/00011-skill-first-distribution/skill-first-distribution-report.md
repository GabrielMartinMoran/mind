> **Historical report for feature 00011-skill-first-distribution.** Frozen on 2026-10-20.
> Current behavior: [Skill-first distribution](../../skill-first-distribution.md).

# Skill-first distribution: implementation report

This report covers feature `00011-skill-first-distribution` on
`feat/cognitive-memory-lifecycle-and-associative-recall`. It records the
lifecycle corrections, the skill-first distribution model, the agent matrix
changes, the benchmark subproject, and the measured verification. It separates
real test runs from static checks and from live-client behavior that was not
verified.

The companion explanation is
[`docs/skill-first-distribution.md`](../../skill-first-distribution.md). The normative
instructions remain
[`src/resources/protocols/mind-cognitive-protocol.md`](../../../src/resources/protocols/mind-cognitive-protocol.md).

## 1. Corrections

Four behavior areas were corrected:

- **Checkpoint partial updates.** `checkpoint_save` now preserves omitted
  fields, clears a field only when it receives an empty string, and applies
  defaults only on creation. A no-op does not advance `updated_at`.
- **Checkpoint completion.** `checkpoint_done` requires empty `pending` and a
  `checkpoint`-tagged target. Pending work returns an actionable error and
  leaves the checkpoint active. Success creates a T3 `session-*` summary and
  copies links in both directions.
- **Session end versus task completion.** Ending a session with pending work
  updates and keeps the checkpoint. The OpenCode plugin no longer creates
  artificial checkpoints with placeholder content.
- **Supersession and prompting.** Supersession preserves historical content and
  tags, adds `status:superseded`, links the replacement with `contradicts`, and
  updates living references. RECALL starts with a natural query; RELATE
  distinguishes `links_to` from `link_create`.

## 2. Skill-first decisions

Mind keeps one canonical protocol body and one complete `mind-management` skill.
L2 setup instructions and MCP `initialize.instructions` are brief activation
text. `system_instructions` stays the complete fallback at version `2.1.0`.

Activation is load-once-per-context and reload-after-compaction. There is no
read-tracking database, no simulated `#pragma once`, no quota, and no artificial
checkpoint. The canonical install path is `~/.agents/skills/mind-management`.
Claude Code and Antigravity receive a symlink or managed copy because they do
not read global `~/.agents/skills`. Setup migrates Mind-managed shadow copies
and refuses to overwrite foreign files.

The merge-readiness pass simplified the policy to the exact name
`mind-management` in a managed path. The ownership marker is provenance, not
authorization, so an old copy without the marker is still updateable. Setup no
longer scans content for historical signatures, and other skills are never
modified.

## 3. Clients and capabilities verified

The capability model keeps L1 MCP, L2 instruction injection, and L3 hooks
separate from skill installation. Offline evidence verifies generated paths,
configuration shapes, safe writes, idempotency, the MCP handshake, and the
capability metadata. It does not verify live client runtime behavior.

| Client            | L1 MCP | L2 instructions | L3 hooks     | Skill surface    |
| ----------------- | ------ | --------------- | ------------ | ---------------- |
| OpenCode          | Yes    | Yes             | Yes          | Shared canonical |
| Claude Code       | Yes    | Yes             | Yes (opt-in) | Symlink or copy  |
| Codex             | Yes    | Yes             | No           | Shared canonical |
| Cursor            | Yes    | Unverified      | Unverified   | Shared canonical |
| Windsurf / Devin  | Yes    | No              | No           | Shared canonical |
| Gemini CLI        | Yes    | No              | No           | Shared canonical |
| VS Code / Copilot | Yes    | No              | No           | Shared canonical |
| Antigravity       | Yes    | No              | No           | Symlink or copy  |
| Pi Agent          | Yes    | Yes             | Unverified   | Shared canonical |

All MCP wiring uses stdio command transport. The stale "URL" wording for Cursor
and Gemini CLI was corrected. Antigravity now states plainly that it has no L2
instruction injection and that the skill is a separate surface.

Unverified live behavior: Cursor event payloads, argv shape, and hook execution;
skill activation and hook firing for Pi, Windsurf/Devin, VS Code/Copilot,
Antigravity, and Gemini CLI.

## 4. Pi Agent

Pi means the Pi agent from Earendil. Mind writes `~/.pi/agent/mcp.json` with
`mcpServers.mind` over stdio, upserts a brief managed pointer in
`~/.pi/agent/AGENTS.md`, and installs the shared `~/.agents` skill while
migrating only Mind-managed `~/.pi/agent/skills` shadows. Mind installs no Pi
plugin. Pi documents extensions, but L3 remains unverified.

## 5. Install paths and mechanism

The canonical skill is `~/.agents/skills/mind-management/SKILL.md`. Clients that
discover `~/.agents` use it directly. Claude Code links or copies to
`~/.claude/skills/mind-management`; Antigravity links or copies to
`~/.gemini/config/skills/mind-management`.

The installer writes an ownership marker as provenance, backs up
content-changing writes, writes atomically through a temporary sibling file,
and skips byte-identical content. A same-name `mind-management` file in a
managed path is updateable with or without the marker; other skills are never
touched. Classification uses `lstat`: a foreign or broken symlink is recorded as
`LINK_TARGET=<target>` in a backup sidecar and replaced without writing through
it, and a non-directory managed path is repaired instead of raising `ENOTDIR`.
Auxiliary files stay in place. On Windows, setup creates a directory junction
and falls back to a copy. Shadow copies in OpenCode, Cursor, Windsurf, VS Code,
Gemini, Pi, and legacy Antigravity paths are backed up and removed only when
Mind generated them.

## 6. MCP changes

`createMcpServer` now passes `instructions: renderSkillActivation()` to the MCP
`Server`. The stdio and HTTP transports share the same server, so both expose
the brief activation during `initialize`. `system_instructions` still returns
the full protocol and reports version `2.1.0`.

The global "See system_instructions" suffix was removed from tool descriptions.
Tool descriptions are self-contained, and the fallback is described where it
belongs.

## 7. Checkpoints and supersession

Checkpoint updates are partial by contract: omitted means keep, empty means
clear, and defaults apply only at creation. Active checkpoints are found in all
tiers. `linked_memories` is additive and reports failures; it never downgrades a
specific label to `related`. Completion validates the target tag and the empty
pending field, creates the T3 summary, and deletes the checkpoint only on
success.

Supersession creates a replacement, marks the historical memory with its
original category tag plus `status:superseded`, leaves its content unchanged,
links replacement to history with `contradicts`, and updates living references.
`memory_update.tags` replaces the set, so the historical call re-includes every
original tag.

## 8. Benchmark structure

`benchmarks/agent-memory/` is an independent Bun subproject with its own
`package.json`, `bun.lock`, and `tsconfig.json`. It declares
`@opencode/sdk@2.0.28` as its own dependency. The root project has no Bun
workspace, so a root install never installs the harness.

The subproject scripts cover unit and contract tests, experiments, integration
tests, typecheck, probes, smoke, LoCoMo, scenarios, full orchestration, report,
and clean. The root `Makefile` delegates with `cd`, and `clean` resolves run and
work directories against the repository root.

CI has two jobs. `validate` runs the root install, typecheck, format, lint, and
tests. `benchmark-agent-memory` runs the subproject frozen install, typecheck,
unit and contract tests, and experiment tests. Neither job runs a paid stage.

## 9. Dependencies removed from root

`@opencode/sdk` moved from the root to the benchmark subproject. `bun-style`
was no longer used; terminal styling uses `ansi-styles`. The root lockfile was
regenerated with Bun rather than edited by hand.

### Root dependencies before and after

The table compares the root manifest before and after the benchmark dependency
move.

| Dependency                  | Before   | After   |
| --------------------------- | -------- | ------- |
| `@modelcontextprotocol/sdk` | Present  | Present |
| `ansi-styles`               | Present  | Present |
| `bun-style`                 | `^0.3.2` | Removed |
| `jsonc-parser`              | Present  | Present |
| `yaml`                      | Present  | Present |
| `zod`                       | Present  | Present |
| `@opencode/sdk` (dev)       | `2.0.28` | Removed |

The benchmark subproject declares `@opencode/sdk@2.0.28`, `@types/bun` (latest,
resolved `1.4.3`), and `typescript ^6.0.2` (resolved `6.0.3`).

## 10. Lockfile status

Both projects have a Bun lockfile and install from it with
`--frozen-lockfile`:

- Root `bun.lock`: no `@opencode/sdk`, no `bun-style`.
- `benchmarks/agent-memory/bun.lock`: contains `@opencode/sdk@2.0.28` and the
  subproject's dev dependencies.

The root is Bun-only. `bun.lock` is the only root lockfile, and
`package-lock.json` was removed in the merge-readiness pass. The release script
no longer reads, writes, or aligns npm-lock versions, so the repository does
not imply a second package manager.

## 11. Tests and results

All checks below were free. No paid benchmark stage ran, no real user home was
modified, and no live database was opened.

| Check                     | Command                                                                 | Result                    |
| ------------------------- | ----------------------------------------------------------------------- | ------------------------- |
| Root suite                | `bun test test/ web/test`                                               | 1386 pass, 8 skip, 0 fail |
| Root typecheck            | `bun run typecheck`                                                     | Pass                      |
| Root lint                 | `bun run lint`                                                          | Pass                      |
| Root format               | `bun run format:check`                                                  | Pass                      |
| Root frozen install       | `bun install --frozen-lockfile`                                         | Pass                      |
| Benchmark suite           | `cd benchmarks/agent-memory && bun test test`                           | 388 pass, 8 skip, 0 fail  |
| Benchmark experiments     | `cd benchmarks/agent-memory && bun test experiments`                    | 105 pass                  |
| Free OpenCode integration | `BENCH_INTEGRATION=1 bun test test/skill-discovery.integration.spec.ts` | 1 pass                    |
| Benchmark typecheck       | `cd benchmarks/agent-memory && bun run typecheck`                       | Pass                      |
| Benchmark frozen install  | `cd benchmarks/agent-memory && bun install --frozen-lockfile`           | Pass                      |

What the evidence proves:

- **Real tests.** The root suite, benchmark suites, and experiment suite execute
  code and assert behavior. They cover checkpoint partial updates, completion
  validation, supersession contracts, protocol rendering, skill installation,
  MCP instructions, agent configuration, and benchmark isolation.
- **Static or configuration validation.** Typecheck, lint, format, frozen
  installs, dependency-tree checks, path checks, and manifest inspection verify
  structure and text without exercising a live client.
- **Free OpenCode validation.** The gated integration run uses OpenCode 2.0.28
  with no model call and verifies skill discovery, the brief L2 instruction,
  MCP configuration and handshake, `/api/skill` polling, and the isolation
  allowlist.
- **Not verified.** Live skill activation by a model, live hook firing, Cursor
  payloads and argv, compaction (disabled by `OPENCODE_DISABLE_AUTOCOMPACT=1`),
  and any paid benchmark stage including B11. These remain unverified; no paid
  subscription was used to claim otherwise.
- **CI.** Workflow behavior is checked locally with static assertions. The
  workflow has not run on GitHub for this branch. The audit step is absent
  because `bun audit --audit-level=high` fails on pre-existing advisories;
  dependency upgrades are a separate follow-up.

## 12. Limitations and unverified behavior

- Cursor L3 hook execution, event payload shape, and argv shape remain
  unverified. The documented envelope is implemented, but the integration is not
  claimed functional.
- Pi, Windsurf/Devin, VS Code/Copilot, Antigravity, and Gemini CLI live skill
  activation and hook behavior remain unverified.
- The benchmark experiments are runnable but excluded from the subproject
  typecheck because of long-standing pre-existing type errors. The subproject
  has no lint script, and the root ESLint config lints them with a non-type-aware
  pass.
- Paid B11 is prepared but not run, so live skill activation, protocol use,
  and cross-session continuity remain unverified.
- `OPENCODE_DISABLE_AUTOCOMPACT=1` prevents compaction validation today.
- CI has not run on GitHub for this branch, and dependency advisories remain an
  open follow-up rather than a passing audit.
- The root is Bun-only; `package-lock.json` was removed and `bun.lock` is the
  only lockfile.
- No commit was made by this documentation task; the working tree remains for
  review.
- Documentation correctness is checked by tests, format, lint, typecheck, and
  relative-link inspection. It is not a substitute for live client review.

## Recommendation

The feature meets its documented and offline-verified scope. Continue with
final QA. Keep the live-client items marked unverified until a free,
reproducible client run records them.

## Related documentation

- [Skill-first distribution](../../skill-first-distribution.md)
- [Cognitive memory lifecycle](../../cognitive-memory-lifecycle.md)
- [Agent integration matrix](../../agent-integration-matrix.md)
- [Merge-readiness report](../00012-merge-readiness/merge-readiness-report.md)
- [Agent memory benchmark](../../../benchmarks/agent-memory/README.md)
