# Agent setup and integration behavior

Use `mind setup` to configure all supported integrations, or `mind setup <agent>`
to configure one. Agent applications are not installed by this command.
This page records integration details; the [integration matrix](agent-integration-matrix.md)
tracks which capabilities have been implemented and validated.

Mind supports multiple agent integrations, but they are not all equally mature.
Run `mind setup` to configure all supported agents, or add an agent name to
configure just that agent. Use `mind setup compatibility` to inspect the
capability matrix before setup. Setup configures Mind's integration files; it
doesn't install the agent applications themselves and may create settings for
agents that aren't installed locally.

```bash
mind setup              # configure all supported agents
mind setup compatibility
mind setup claude-code
mind setup opencode
mind setup cursor
mind setup codex
mind setup windsurf
mind setup gemini-cli
mind setup vscode
mind setup antigravity
mind setup pi
mind setup refresh      # refresh detected mind-managed integrations
```

`mind setup refresh` is conservative by default. It refreshes only detected
integrations, where detection means Mind finds an existing Mind-owned signal,
such as an MCP config, managed activation pointer block, hook/plugin/script, or
installed mind-management skill. Use `--dry-run` to preview changes, `--all` to
refresh all supported agents, or `--agent <name>` to target one agent. The
`--all` option remains available for existing scripts; `mind setup` is the
shorter command for configuring every supported agent.

### Skill-first protocol

Mind keeps one canonical protocol and one complete `mind-management` skill. The
skill installs once at `~/.agents/skills/mind-management`; Claude Code and
Antigravity receive a symlink or managed copy because they do not read the
global directory. The skill is the single source of truth for Mind. Load it
unconditionally at session start and after compaction, before any Mind use; do
not call a Mind MCP tool until it is loaded. Client L2 instructions and the MCP
`initialize.instructions` handshake are activation pointers, not the protocol.
If the skill is not listed or cannot be loaded, call the `system_instructions`
MCP tool for the complete protocol at version `2.3.0`. That fallback is
complete but secondary; the skill is the primary source of truth.

Mind does not track reads in a database, enforce a quota, or create a checkpoint
just to record activation. Setup updates only the exact `mind-management` skill
in its managed locations; it leaves other skills untouched and replaces
`SKILL.md` atomically without leaving a skill backup. Ancestor-repair and agent
config backups remain outside skill paths. Older skill backups are not deleted
automatically; remove them manually if desired. See the [documentation index](README.md),
[skill-first distribution](skill-first-distribution.md), and the
[agent integration matrix](agent-integration-matrix.md).

### Agent integration details

Use the commands in [Get started](../README.md#get-started) to run setup. This section
explains how to read the capability matrix and what each integration actually
configures.

`mind setup compatibility` prints a capability matrix per integration using a 3-level model:

- **L1**: MCP transport wiring
- **L2**: instruction/protocol injection
- **L3**: hooks/session/compaction automation

Each level is explicitly marked as `supported`, `unsupported`, or `unverified` with evidence/fallback notes.
If a capability is not implemented, setup output is explicit (no silent skip).

#### Agent status matrix

Status labels used here:

- **Complete**: L1/L2/L3 are all `supported`
- **Partial**: at least one level is `unsupported` or `unverified`
- **Experimental**: declaration exists but integration is explicitly unstable/unverified
- **Roadmap**: planned declaration only, no adapter wiring

| **Agent**         | **Status** | **Capability reality**                                        |
| :---------------- | :--------- | :------------------------------------------------------------ |
| OpenCode          | Complete   | L1 `supported`, L2 `supported`, L3 `supported`                |
| Claude Code       | Complete   | L1 `supported`, L2 `supported`, L3 `supported` (opt-in hooks) |
| Codex             | Partial    | L1 `supported`, L2 `supported`, L3 `unsupported`              |
| Cursor            | Partial    | L1 `supported`, L2 `unverified`, L3 `unverified`              |
| Windsurf / Devin  | Partial    | L1 `supported`, L2 `unsupported`, L3 `unsupported`            |
| Gemini CLI        | Partial    | L1 `supported`, L2 `unsupported`, L3 `unsupported`            |
| VS Code / Copilot | Partial    | L1 `supported`, L2 `unsupported`, L3 `unsupported`            |
| Antigravity       | Partial    | L1 `supported`, L2 `unsupported`, L3 `unsupported`            |
| Pi Agent          | Partial    | L1 `supported`, L2 `supported`, L3 `unverified`               |

Skill installation is reported separately from the L1/L2/L3 badges. Mind
installs one canonical skill at `~/.agents/skills/mind-management`; Claude Code
and Antigravity receive a symlink (or managed copy fallback), and managed
shadow copies in client-specific skill directories are migrated. See
[`docs/agent-integration-matrix.md`](agent-integration-matrix.md) for the
documented paths, instruction support, hooks, and unverified surfaces.

Rollout policy:

- Wave 1 priority agents: **OpenCode, Claude Code, Gemini CLI, Cursor**
- Claude Code now includes managed **L2 protocol injection** by writing `~/.claude/instructions/mind-memory-protocol.md` and maintaining a managed block in `~/.claude/CLAUDE.md`
- Claude Code **L3 hooks automation is opt-in and non-blocking** (default off). Enable with `MIND_SETUP_CLAUDE_ENABLE_HOOKS=true` before running setup.
- Cursor **L2** remains intentionally **unverified** (no verified global user-rules injection path)
- Cursor **L3** writes the documented `{ "version": 1, "hooks": { ... } }` schema with `sessionStart`, `preCompact`, `sessionEnd`, and `stop`, but hook execution is marked **unverified** because it was not live-tested
- Existing integrations outside Wave 1 remain wired in the same capability model with explicit status
- Windsurf/Devin writes `~/.config/devin/mcp_config.json` (the legacy `~/.windsurf/mcp.json` path is detection-only); VS Code/Copilot writes portable `~/.copilot/mcp-config.json`; Antigravity writes `~/.gemini/config/mcp_config.json` and uses `~/.gemini/config/skills`
- Pi Agent is a **supported** L1/L2 integration with MCP at `~/.pi/agent/mcp.json`, a managed activation pointer in `~/.pi/agent/AGENTS.md`, and the shared `~/.agents` skill; Mind does not install a Pi plugin and marks L3 **unverified**
- Codex, Gemini CLI, VS Code/Copilot, and Antigravity document hooks, but Mind does not implement L3 automation for them

`mind setup opencode` is idempotent and non-destructive:

- prefers `~/.config/opencode/opencode.jsonc` over `opencode.json` when both exist, and never creates `opencode.json` if `opencode.jsonc` is already present. New files are created as `opencode.jsonc` (the JSONC superset of JSON that OpenCode accepts natively).
- preserves unknown keys already present in the chosen config file
- configures `mcp.mind` as local command transport (`type: "local"`, `command: ["<path-to-mind>", "mcp"]`)
- writes/refreshes `~/.config/opencode/instructions/mind-memory-protocol.md`
- ensures that instruction file is present in OpenCode's `instructions` list
- configures prudent L3 session/compaction automation by default and non-blocking, writing `~/.config/opencode/plugins/mind-automation.js` during setup. The generated plugin default-exports an OpenCode V2 plugin definition (`id` + `setup`) and also exposes V1 `server()` hooks, so the same file loads on OpenCode V2 and on V1 builds that support object plugin entrypoints (1.18.29+); older V1 builds keep loading it through the named `MindAutomationPlugin` export

> **Setup safety contract:** all setup flows that touch a user-owned JSON/JSONC config file (opencode, claude fallback, cursor, windsurf/devin, gemini-cli, vscode/copilot, antigravity, pi) now go through `src/setup/safe-config.ts`. Existing files are parsed strictly — a parse failure aborts the run with a clear error rather than overwriting the file with an empty default. Content-changing writes are preceded by a timestamped sibling backup (`.bak.YYYYMMDDTHHMMSSmmmZ`) and the new content is staged in a sibling `.tmp` file and renamed into place so a crash mid-write cannot leave a partial file. The same contract applies to `mind setup refresh`.

`mind setup codex` keeps setup idempotent and writes local MCP command args in `~/.codex/config.toml`:

- `[mcp_servers.mind]`
- `command = "<path-to-mind>"`
- `args = ["mcp"]`

It also non-destructively upserts a managed Mind activation pointer block in `~/.codex/AGENTS.md`. Project `AGENTS.md` files must point to the skill and fallback, not restate the protocol.

`mind setup cursor` keeps existing MCP setup behavior and configures global L3 hooks using the documented envelope:

- writes/updates `~/.cursor/hooks.json` using the documented `{ "version": 1, "hooks": { ... } }` schema with managed idempotent entries for `sessionStart`, `preCompact`, `sessionEnd`, and `stop`
- writes/refreshes a non-mutating shim script at `~/.cursor/hooks/mind-session-continuity.sh` for those events; it does not create, overwrite, or complete checkpoints
- preserves unrelated hook config keys and entries, and migrates an older top-level event map into the documented envelope
- hook execution and payload shape are marked **unverified** because they were not live-tested

`mind setup pi` configures the Pi Agent with the minimal integration:

- writes `~/.pi/agent/mcp.json` with `mcpServers.mind` over stdio
- upserts a managed activation pointer block in `~/.pi/agent/AGENTS.md` without touching unrelated content
- installs the shared `~/.agents/skills/mind-management` skill and migrates a managed Pi-specific shadow copy
- does not install a Pi plugin; Pi documents extensions, but Mind marks hook automation **unverified**

Check server process status:

```bash
mind server-status
```
