# Agent integration matrix

This page records what Mind actually wires for each supported agent. It
separates documented client behavior from Mind's implementation and from live
validation. Access date for the official links: October 20, 2026.

## Reading the matrix

- **Documented** means the client publishes the path or shape Mind uses.
- **Implemented** means `mind setup <agent>` writes or installs it.
- **Validated** means a live client run confirmed the behavior. Mind validates
  only what it can run without a paid subscription or a real user home.
- **Unverified** means the integration exists but was not live-tested.

Capability badges remain L1 MCP, L2 instruction injection, and L3
hooks/session automation. Skill installation is a separate surface and is not a
fourth badge.

## Matrix

The matrix records the MCP path, skill path, install strategy, MCP
`initialize.instructions` support, hooks status, Mind strategy, validation
state, and known limitation for each supported client.

| Client                   | MCP path                                                                   | Skills path                               | Symlink strategy                            | MCP `initialize.instructions`                                                                                                                                                | Hooks / compaction                                                                                                         | Mind strategy                                                                                              | Documented / implemented / validated / unverified                                                                 | Limitations                                                                                                                                         |
| ------------------------ | -------------------------------------------------------------------------- | ----------------------------------------- | ------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| OpenCode                 | `~/.config/opencode/opencode.jsonc` (or `.json`), `mcp.mind` local command | `~/.agents/skills/mind-management`        | Shared canonical directory                  | Surfaced                                                                                                                                                                     | Managed plugin handles session and compaction continuity                                                                   | Write config, brief L2 instruction, managed plugin, shared skill                                           | Documented yes, implemented yes, validated previously for MCP/L2/L3 in feature 00010, skill activation unverified | Skill discovery in the current client build was not re-validated in this task                                                                       |
| Claude Code              | `~/.claude/settings.json` or `~/.claude.json`, `mcpServers.mind`           | `~/.claude/skills/mind-management`        | Symlink to canonical, managed copy fallback | Surfaced, truncated to 4096 characters                                                                                                                                       | Opt-in `Stop` hook via `MIND_SETUP_CLAUDE_ENABLE_HOOKS=true`                                                               | Write config, managed protocol file and block, optional hook, linked skill                                 | Documented yes, implemented yes, validated no, live skill/hook activation unverified                              | Claude does not read `~/.agents/skills`, so it needs the dedicated link                                                                             |
| Codex                    | `~/.codex/config.toml`, `[mcp_servers.mind]`                               | `~/.agents/skills/mind-management`        | Shared canonical directory                  | Surfaced                                                                                                                                                                     | Client documents hooks; Mind implements none                                                                               | Write TOML stanza, managed `AGENTS.md` block, shared skill                                                 | Documented yes, implemented yes, validated no, L3 unsupported                                                     | L2 is a brief pointer; Mind does not ship Codex hook automation                                                                                     |
| Cursor                   | `~/.cursor/mcp.json`, `mcpServers.mind`                                    | `~/.agents/skills/mind-management`        | Shared canonical directory                  | Not documented                                                                                                                                                               | Documented `{ "version": 1, "hooks": { ... } }` envelope is implemented; event payload, argv, and execution are unverified | Write config, documented hook file and script, shared skill                                                | Documented yes, implemented yes, validated no, L3 unverified                                                      | Do not claim functional L3. Hook execution and payload/argv shape were not live-tested; older top-level hook maps are migrated                      |
| Windsurf / Devin         | `~/.config/devin/mcp_config.json`, `mcpServers.mind`                       | `~/.agents/skills/mind-management`        | Shared canonical directory                  | Not documented                                                                                                                                                               | Not implemented                                                                                                            | Write documented config, shared skill; read legacy `~/.windsurf/mcp.json` for detection only               | Documented yes, implemented yes, validated no, L2/L3 unsupported                                                  | Legacy `~/.windsurf/mcp.json` is never written                                                                                                      |
| Gemini CLI               | `~/.gemini/settings.json`, `mcpServers.mind`                               | `~/.agents/skills/mind-management`        | Shared canonical directory                  | Surfaced                                                                                                                                                                     | Client documents hooks; Mind implements none                                                                               | Write config, shared skill                                                                                 | Documented yes, implemented yes, validated no, L2/L3 unsupported                                                  | Managed protocol injection is not implemented; the skill is the protocol path                                                                       |
| VS Code / GitHub Copilot | `~/.copilot/mcp-config.json`, `mcpServers.mind`                            | `~/.agents/skills/mind-management`        | Shared canonical directory                  | Not documented                                                                                                                                                               | Client documents hooks; Mind implements none                                                                               | Write portable Copilot config, shared skill; document the VS Code-native `servers` shape as an alternative | Documented yes, implemented yes, validated no, L2/L3 unsupported                                                  | Mind writes one file and does not duplicate the same server into VS Code-native `mcp.json`                                                          |
| Antigravity              | `~/.gemini/config/mcp_config.json`, `mcpServers.mind`                      | `~/.gemini/config/skills/mind-management` | Symlink to canonical, managed copy fallback | Not documented                                                                                                                                                               | Client documents hooks; Mind implements none                                                                               | Write documented config and linked skill; no L2 instruction injection                                      | Documented yes, implemented yes, validated no, L2/L3 unsupported                                                  | Antigravity does not read global `~/.agents/skills`; the skill surface is separate from L2. Legacy `~/.gemini/antigravity` paths are migration-only |
| Pi Agent                 | `~/.pi/agent/mcp.json`, `mcpServers.mind`                                  | `~/.agents/skills/mind-management`        | Shared canonical directory                  | MCP server emits the brief activation in `initialize.instructions`; client rendering is unverified (Pi docs describe using the first instruction line or server description) | Pi documents extensions; Mind builds no Pi plugin                                                                          | Write config, brief managed `AGENTS.md` block, shared skill                                                | Documented yes, implemented yes, validated no, L3 unverified                                                      | No Pi-specific plugin, hook, or copy of the skill                                                                                                   |

## Benchmark subproject and CI

The agent memory benchmark is not an agent integration. It lives in
`benchmarks/agent-memory/` as an independent Bun subproject with its own
`package.json`, `bun.lock`, and `tsconfig.json`, and it declares
`@opencode/sdk@2.0.28` itself. The root project is not a workspace and does not
install the harness.

CI runs two free jobs. The `validate` job installs the root project from its
frozen lockfile and runs typecheck, format, lint, and tests. The
`benchmark-agent-memory` job installs the subproject from its frozen lockfile and
runs typecheck, unit and contract tests, and experiment tests. Neither job runs a
paid stage. The subproject experiments are excluded from its typecheck because of
long-standing pre-existing type errors; the root ESLint config still lints the
experiments without type information.

## Sources

The links below are the official client documentation used to choose each path
and configuration shape.

- OpenCode MCP and configuration: [opencode.ai/v2/docs/mcp-servers](https://opencode.ai/v2/docs/mcp-servers) and [opencode.ai/v2/docs/config](https://opencode.ai/v2/docs/config).
- Claude Code MCP: [docs.anthropic.com/en/docs/claude-code/mcp](https://docs.anthropic.com/en/docs/claude-code/mcp).
- Codex MCP: [developers.openai.com/codex/mcp](https://developers.openai.com/codex/mcp).
- Cursor hooks and MCP: [cursor.com/docs/agent/hooks](https://cursor.com/docs/agent/hooks) and [cursor.com/docs/context/mcp](https://cursor.com/docs/context/mcp).
- Windsurf Cascade MCP: [docs.windsurf.com/windsurf/cascade/mcp](https://docs.windsurf.com/windsurf/cascade/mcp).
- Gemini CLI MCP: [github.com/google-gemini/gemini-cli](https://github.com/google-gemini/gemini-cli/blob/main/docs/tools/mcp-server.md).
- VS Code and GitHub Copilot MCP: [code.visualstudio.com/docs/copilot/customization/mcp-servers](https://code.visualstudio.com/docs/copilot/customization/mcp-servers).
- Antigravity MCP: [antigravity.google/docs/mcp](https://antigravity.google/docs/mcp).
- Pi Agent MCP, skills, and configuration: [Pi MCP docs](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/mcp.md), [Pi skills docs](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/skills.md), and [Pi configuration docs](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/configuration.md).

## Validation policy

Mind does not use paid subscriptions or a real user home to claim live client
behavior. Static configuration tests, safe-write tests, capability metadata,
and the MCP handshake are the offline evidence. Live skill activation, hook
execution, and client-specific instruction rendering remain unverified unless a
later validation records a free, reproducible run.
