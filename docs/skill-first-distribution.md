# Skill-first distribution

Mind ships one complete `mind-management` skill, installs it once in a global
location, and keeps every agent integration pointing at that single source. The
model solves three problems: duplicated protocol text drifts, per-client copies
shadow each other, and long instruction payloads get truncated or ignored.

This page explains the distribution model and the lifecycle rules that keep it
consistent. The normative instructions themselves live in the canonical
protocol at
[`src/resources/protocols/mind-cognitive-protocol.md`](../src/resources/protocols/mind-cognitive-protocol.md).
Read the protocol for the exact tool calls; read this page to understand how
Mind delivers it.

## One canonical body, one complete skill

Mind keeps a single token-free protocol body. Three render paths consume it:

- **The skill.** `mind-management` is the complete artifact an agent loads. It
  combines YAML frontmatter, a short self-load note, and the full protocol
  body.
- **L2 instructions.** Setup writes a brief activation that names the skill and
  the fallback. It does not repeat the body.
- **MCP `initialize.instructions`.** The server returns the same brief
  activation during the handshake.

`system_instructions` remains the complete protocol and the explicit fallback
when the skill cannot be loaded. The response reports
`instructions_version: "2.1.0"`.

`src/cli/skill-activation.ts` owns the activation text and the skill load note.
Changing the wording there updates setup and the MCP handshake together. No
client receives an independent complete copy of the protocol.

## Activation is brief, the skill is complete

Loading a skill costs context, so the model loads it once per context and
reloads it after compaction or context loss. It does not track reads in a
database, simulate `#pragma once`, impose a quota, or create an artificial
checkpoint to prove that activation happened.

| Surface                     | Content                         | When it is used               |
| --------------------------- | ------------------------------- | ----------------------------- |
| L2 instructions             | Skill name, load note, fallback | Every session start           |
| MCP initialize instructions | Skill name, load note, fallback | MCP handshake                 |
| `mind-management` skill     | Frontmatter + full body         | Session start and compaction  |
| `system_instructions`       | Full body                       | When the skill is unavailable |

The brief activation survives client truncation and single-line display. Pi,
for example, surfaces only the first instruction line; Claude Code truncates
long initialize instructions. The complete protocol still reaches the agent
through the skill.

## Installation model

The canonical skill lives at `~/.agents/skills/mind-management/SKILL.md`. Clients
that already discover `~/.agents/skills` read it directly, so they do not need a
dedicated copy.

| Client group                      | Target                                    | Strategy               |
| --------------------------------- | ----------------------------------------- | ---------------------- |
| OpenCode, Codex, Pi               | Canonical directory                       | Shared                 |
| Cursor, Windsurf, Gemini, VS Code | Canonical directory                       | Shared                 |
| Claude Code                       | `~/.claude/skills/mind-management`        | Symlink, copy fallback |
| Antigravity                       | `~/.gemini/config/skills/mind-management` | Symlink, copy fallback |

Setup follows an exact-name policy. Only `mind-management` in an explicit
Mind-managed location (the canonical directory, Claude Code, Antigravity, and
the listed legacy shadow directories) is updateable. Any same-name content in
those locations is managed, with or without the ownership marker; a marker is
provenance, not authorization. Setup does not scan content for historical
signatures, and other skill directories are never modified.

The install contract is defensive:

- Install when absent; leave byte-identical content untouched (no write, no
  backup); back up and update when the bytes differ.
- A regular `SKILL.md` backup is a timestamped sibling (`.bak.<timestamp>`).
  When a managed directory contains extra resources, only `SKILL.md` is backed
  up and replaced; the extras stay in place.
- Classification uses `lstat`, so a symlink is never followed. A foreign or
  broken directory symlink, and a file-level `SKILL.md` symlink, are recorded
  as `LINK_TARGET=<target>` in a backup sidecar and replaced without copying or
  writing through external content.
- A non-directory at a managed path is backed up and repaired instead of
  raising `ENOTDIR`.
- Writes stage in a sibling temporary file and rename into place, so a crash
  cannot leave a partial file.
- On Windows, setup creates a directory junction and falls back to a managed
  copy when linking is unavailable. It does not require elevated privileges.

Setup also migrates same-name shadow copies that would take precedence over
the canonical skill, such as an old `~/.cursor/skills/mind-management`. It backs
up the shadowing `SKILL.md`, removes it, and preserves unrelated resources in
the directory. Detection uses `lstat`, so a broken managed link still marks the
integration as installed and can be repaired on the next refresh.

## Checkpoint lifecycle rules

A checkpoint is live work state, not a session receipt. Three corrections make
the lifecycle consistent across MCP, the CLI, and the OpenCode plugin.

**Partial updates preserve omitted fields.** `checkpoint_save` treats an omitted
field as "keep the current value" and an empty string as "clear this field".
Defaults apply only when Mind creates a checkpoint. A call that changes nothing
returns the checkpoint without advancing `updated_at`.

**Session end is not task completion.** When a session ends with work still
pending, the agent updates the checkpoint and leaves it active; it writes a
session summary separately. It calls `checkpoint_done` only when the task is
complete. The OpenCode plugin no longer creates or updates checkpoints with
placeholder content.

**Completion is validated and atomic.** `checkpoint_done` requires an empty
`pending` field and a target that carries the `checkpoint` tag. Pending work
produces an actionable error and leaves the checkpoint active. To abandon work,
clear `pending` explicitly and record the reason in notes. On success, Mind
creates a same-space `session-*` summary at T3 tagged `type:session` and
`cat:summary`, copies inbound and outgoing links, and deletes the checkpoint in
one synchronous SQLite transaction. A summary, link, or delete failure rolls
back the whole transformation, so the checkpoint and its original links stay
intact and a retry cannot duplicate the summary.

Checkpoint lookup searches every tier, so a checkpoint that moved to T3 is still
found and updated instead of spawning a duplicate. Linked memories are additive:
a new call adds valid references and reports invalid ones in `links_failed`;
an empty list removes nothing.

## Supersession, retrieval, and linking

The protocol preserves history and teaches retrieval in the order that works.

**Supersession.** Create the replacement memory first. Mark the historical
memory with its original tags plus `status:superseded`, without changing its
content. Link the replacement to the historical memory with `contradicts`.
Then update the living references that describe the affected area. Never
overwrite the historical content; the old reasoning stays available while the
current answer stays unambiguous.

**Retrieval.** Start with one natural, focused question. Structured syntax
(phrases, `OR`, `AND`, `NOT`, prefixes) is an additional tool for explicit
constraints. The protocol does not require multiple queries. Results carry a
`confidence` bucket and `methods` provenance, so a weak hit is visible.

**Linking.** `memory_add.links_to` creates a generic `related` link. Use
`link_create` when direction and a specific label matter. Re-creating the same
directed pair replaces its label; `link_delete` removes one direction and
succeeds as a no-op when the link is absent. Add links only when they help
future work.

Living references keep the current truth for an area. They need
`type:reference`, exactly one `ref:*` tag, and `status:living`. Update them when
the truth changes, not on a calendar quota.

## Agent matrix summary

Mind declares three capability levels (L1 MCP, L2 instruction injection, L3
hooks and session automation) and reports skill installation as a separate
surface. A capability is `supported`, `unsupported`, or `unverified`; the
matrix never upgrades an unverified behavior to supported.

The full paths, symlink strategies, instruction support, hook status, and
validation notes live in
[`docs/agent-integration-matrix.md`](agent-integration-matrix.md). The important
distinctions are:

- OpenCode previously validated MCP, L2, and plugin behavior. A free
  `BENCH_INTEGRATION=1` check now also validates skill discovery, the brief L2
  instruction, MCP configuration and handshake, and `/api/skill` polling on
  OpenCode 2.0.28 without a model call. Benchmark `mind-current` A2 and B runs
  now apply that same checkout setup in every isolated environment, so the
  benchmark exercises the real integration rather than MCP alone. B11 asserts
  skill-before-Mind ordering per session rather than in aggregate using the
  shared preparation; the paid run has not been executed, so live model behavior
  remains unverified.
- Codex, Cursor, Windsurf/Devin, Gemini CLI, VS Code/Copilot, and Pi use the
  shared canonical skill directly. Claude Code and Antigravity need a dedicated
  link or copy because they do not read global `~/.agents/skills`.
- Cursor writes the documented hooks envelope, but event payloads, argv shape,
  and execution remain unverified. Do not describe Cursor L3 as functional.
- Pi is wired at `~/.pi/agent/mcp.json` with a brief managed pointer in
  `~/.pi/agent/AGENTS.md`, the shared skill, and no Pi plugin. Pi documents
  extensions; Mind does not implement one.

## Benchmark subproject

The agent memory benchmark is an independent Bun subproject under
`benchmarks/agent-memory/`. It owns its `package.json`, `bun.lock`, and
`tsconfig.json`, and declares `@opencode/sdk@2.0.28` as its own dependency. The
root project is not a workspace and does not install benchmark dependencies.

Run the free suites from the subproject:

```sh
cd benchmarks/agent-memory
bun install --frozen-lockfile
bun run typecheck
bun test test
bun test experiments
```

The root `Makefile` delegates to the subproject with `cd`, for example
`make bench-agent-memory-test`. Paid stages still require an explicit
`--budget` cap and have not been run.

Benchmark `mind-current` A2 conditions and B1–B11 units run the real
`<checkout>/mind setup opencode` once per isolated environment. That gives them
the same integration as a normal OpenCode install: the `mind` MCP server, the
canonical `mind-management` skill, the brief L2 activation, and the
`system_instructions` fallback. A1 does not prepare an agent, and historical
`mind-v9`/`mind-v10` plus `no-memory` keep their original integration. B11
asserts skill-before-Mind ordering per session through that shared preparation;
its paid run remains unexecuted. Because current runs now include skill and L2
overhead, current-versus-historical comparisons are not cost-equivalent and paid
budgets need re-approval.

CI installs both projects from their frozen lockfiles. The `validate` job runs
the root audit, typecheck, format check, lint, and tests; the
`benchmark-agent-memory` job runs the subproject audit, typecheck, unit and
contract tests, and experiment tests. Neither job runs a paid stage. The root
uses `bun.lock` only; `package-lock.json` is not part of the project.

Both jobs run `bun audit --audit-level=high` as a blocking gate with no
suppression. As of October 20, 2026, the root audit reports zero advisories. The
benchmark audit passes at high severity with residual moderate (`sprintf-js`)
and low (`@ai-sdk/provider-utils`) advisories that have no upstream fix. CI
triggers on every push (including branches with `/`), every pull request, and
manual dispatch; hosted run evidence for a feature commit is recorded in its
`.pas/` feature report. Do not claim a green run until that run is observed.

## Limitations and unverified behavior

The offline evidence covers configuration generation, safe writes, installation
paths, the MCP handshake, and the full test suites. It does not prove live client
behavior.

- Cursor hook execution, event payload shape, and argv shape remain unverified.
- Live skill activation and hook firing for Pi, Windsurf/Devin, VS Code/Copilot,
  Antigravity, and Gemini CLI remain unverified.
- The benchmark experiments are runnable but excluded from the subproject
  typecheck because of long-standing pre-existing type errors. They are not
  type-aware linted.
- The root is Bun-only: `bun.lock` is the only lockfile, and `package-lock.json`
  was removed.
- A hosted CI run is required for merge evidence. Workflow triggers cover every
  branch and pull request, but local suites and workflow assertions do not
  establish a hosted pass; observe and record the run before claiming green.
  Both audits pass locally, and the benchmark keeps documented moderate and low
  residual advisories.
- No paid benchmark stage, real user home, or live database is used by the
  documented validation. B11 asserts per-session ordering through the shared
  current-only setup, but the paid run remains unexecuted.

## Related documentation

- [Documentation index](README.md)
- [Canonical cognitive protocol](../src/resources/protocols/mind-cognitive-protocol.md)
- [Cognitive memory lifecycle](cognitive-memory-lifecycle.md)
- [Agent integration matrix](agent-integration-matrix.md)
- [Agent memory benchmark](../benchmarks/agent-memory/README.md)
