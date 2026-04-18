# 🧠 Mind

_**Stop losing context across sessions, tools, and time. Give your AI workflow a memory that lasts.**_

Mind is a local memory layer for AI workflows: a persistent memory system for
durable context such as decisions, bug fixes, patterns, checkpoints, and
session summaries that would otherwise disappear across sessions and tools.

It supports recovery after compaction through checkpoint and session
continuity behavior, while giving humans a way to visualize, inspect, and
modify that memory through the CLI and web UI.

**Why Mind works above the fold:**

- **Local persistent store.** One SQLite-backed memory system you control.
- **Built for agent workflows.** Use it through the CLI, MCP server, HTTP API,
  and web UI.
- **Resumption tools included.** Checkpoints and session summaries help recover
  context and continue work.
- **Optional file sync.** Experimental autosync can mirror project spaces into
  versioned `.mind/` files.
- **Search when you need it.** Full-text search is built in, and semantic
  search is available as an optional add-on.

Get started with [Installation](#installation) or jump straight to the
[Quick start](#quick-start).

![Mind Preview](./assets/video/web-preview.gif)

## Why try Mind?

Mind helps you keep durable context organized, retrievable, and usable as work
moves across tools, sessions, and compaction boundaries.

- **Structured memory you can revisit.** Organize information into spaces,
  tags, directional links, tiers, pins, checkpoints, and session summaries.
- **Recovery built into the workflow.** Restore context after compaction,
  resume work from checkpoints, and keep important state visible over time.
- **Shared interfaces, one memory layer.** Use the CLI, MCP server, HTTP API,
  and web app against the same local source of truth.
- **Per-space visibility with Neural Map.** Each space includes a read-only
  graph view so you can understand how memories connect without claiming a
  global knowledge graph.

## What is Mind?

Mind is a Bun + TypeScript project that provides a CLI, an MCP server, an HTTP
API, and a web UI on top of one local SQLite memory store (`mind.db`). It uses
FTS5 full-text search, metadata filters, tags, links, and a 3-tier memory
model (T1 hot, T2 warm, T3 cold) to keep saved context useful over
time.

If you want semantic search, you can enable optional OpenAI embeddings. They
are off by default.

## Installation

You can install Mind quickly and start using it right away. If you want agent
setup later, jump to [Agent setup](#agent-setup).

### One-line installer (recommended)

```bash
curl -fsSL https://raw.githubusercontent.com/GabrielMartinMoran/mind/main/scripts/install.sh | bash
```

This installs Mind to user-local paths (no sudo):

- app: `~/.local/share/mind`
- launcher: `~/.local/bin/mind`

Then run:

```bash
mind help
```

### Requirements

- [Bun](https://bun.sh/) 1.2+ (auto installed by the one-line installer if not present)

### Install from source

```bash
git clone https://github.com/GabrielMartinMoran/mind.git
cd mind
bun install
```

### Quick start

This is the fastest way to see what Mind feels like in practice.

```bash
# Create a project space
mind create projects/my-project "My project"

# Add a memory
mind add projects/my-project architecture "CLI uses command registry + atomic command modules"

# Search across memories
mind search architecture

# Start the web UI
mind serve start
# Open http://localhost:30303
```

### Agent setup

Mind supports multiple agent integrations, but they are not all equally mature.
Run `mind setup` without an agent name to see the current capability matrix,
then configure the specific agent you want.

```bash
mind setup              # show capability matrix first
mind setup claude-code
mind setup opencode
mind setup cursor
mind setup codex
mind setup windsurf
mind setup gemini-cli
mind setup vscode
mind setup antigravity
```

### Post-install configuration

Most configuration is optional. You only need extra setup if you want to change
paths, ports, or enable semantic search.

**1. Create your .env file:**

```bash
cp .env.example .env
```

Mind ships with a `.env.example` that contains all configurable options. The installer will also do this automatically if `.env` doesn't exist.

**2. Configure environment variables (optional):**

Edit `.env` to customize your setup:

| Variable         | Default   | Description                             |
| ---------------- | --------- | --------------------------------------- |
| `MIND_PORT`      | `30303`   | Port for the web server                 |
| `MIND_DATA_DIR`  | `data/`   | Directory for SQLite database and data  |
| `MIND_RAG`       | _(empty)_ | Set to `true` to enable semantic search |
| `OPENAI_API_KEY` | _(empty)_ | Your OpenAI API key (required for RAG)  |

**RAG / semantic search setup:**

To enable AI-powered semantic search:

```bash
# In .env:
MIND_RAG=true
OPENAI_API_KEY=sk-your-key-here
```

When enabled, memories are embedded using OpenAI's
`text-embedding-3-small` model and combined with full-text search for hybrid
retrieval.

## Basic CLI example

```bash
mind create projects/mind "Mind project memory"
mind add projects/mind architecture "CLI uses command registry + atomic command modules"
mind search architecture
```

For the full command list:

```bash
mind help
```

## Usage

### CLI

```bash
mind help
mind create <space> "description"
mind update <space> --hidden
mind list --hidden
mind add <space> <name> "content"
mind list <space>
mind read <space> <name>
mind checkpoint set <space> "goal" "pending"
mind checkpoint recover <space> --name <checkpoint-name>
mind checkpoint complete <space> <name> "what was done"
mind checkpoint list <space> --status active
mind search "query"
mind query --space <space> --from 2026-01-01 --to 2026-12-31 --limit 20 --offset 0
mind update --check
mind update
```

### Autosync (Experimental)

Autosync lets you mirror project spaces to a versioned `.mind/` directory so
you can review memory files in git, edit markdown on disk, and sync those
changes back into the local database.

<!-- prettier-ignore -->
> [!NOTE]
> This is an experimental feature currently under active development.

Set up autosync with the following flow:

1. Run `mind sync init` to create `.mind/config.yml` and `.mind/.gitignore`.
2. Review or edit `.mind/config.yml` to choose which spaces are configured.
3. Run `mind sync enable --space <name>` for the project space you want to
   sync.
4. Run `mind sync serve --space <name>` to start the watcher in the current
   terminal, or rely on MCP startup to auto-start watchers for enabled spaces.

The `.mind/` directory uses a file-based config and hashed space directories:

```text
.mind/
├── config.yml
├── .gitignore
└── spaces/
    └── a1b2c3d4/
        ├── manifest.json
        └── memory-name.md
```

Use these commands to manage autosync:

- `mind sync init`
- `mind sync status`
- `mind sync enable --space <name>`
- `mind sync disable --space <name>`
- `mind sync now --space <name>`
- `mind sync export --space <name>`
- `mind sync import --space <name>`
- `mind sync conflict --space <name> --strategy <strategy>`
- `mind sync remove --space <name>`
- `mind sync config`
- `mind sync serve --space <name>`

Conflict strategies:

- `db-wins`
- `file-wins`
- `latest-wins`

Example `.mind/config.yml`:

```yaml
# mind autosync config

version: 1

# Spaces to sync with this project
# To enable a new space, add it below with enabled: true
# Valid conflictResolution values: db-wins, file-wins, latest-wins
spaces:
  # projects/mind:
  #   enabled: true
  #   conflictResolution: db-wins
```

Current limitations and caveats:

- Existing-memory imports update content only. They do not restore full
  metadata parity from files.
- Exported `links_to` values are written to frontmatter, and imports recreate
  those links in the database.
- Deleting a synced markdown file does not auto-delete the corresponding
  database memory.
- `sync serve` runs in the foreground only.

### Web Server

```bash
mind serve start
mind serve start --port 8080
mind serve start --detached
mind serve stop
```

### Neural Map (Web MVP)

In the web UI, each space now has a **Neural Map** view:

- read-only graph per space
- concentric rings by tier (**T1..T3**)
- pan + zoom controls
- node prominence based on connectivity (link degree)
- click a node to fetch/show memory details via existing memory detail endpoint

The SPA uses URL-driven client routing for reliable deep-linking and reload recovery:

- `/` → spaces home
- `/spaces/{encodedSpace}`
- `?view=list|map`
- optional `?memory={encodedMemory}`

Navigation updates the URL (space open, list/map switch, memory selection), reload restores state, and browser back/forward is supported via History API.

Graph API endpoint used by the SPA:

- `GET /api/spaces/:space/graph?limit=<n>`
- returns minimal payload per node: `id`, `name`, `tier`, `links_to:number[]`, `linked_by:number[]`
- includes all tiers by default
- includes truncation metadata (`total_nodes`, `returned_nodes`, `requested_limit`, `applied_limit`, `max_limit`, `truncated`)

### MCP Server

```bash
mind mcp                           # stdio mode
mind mcp start --http              # HTTP mode
mind mcp start --http --detached   # HTTP background
mind mcp stop
```

When the MCP server starts, it auto-starts autosync watchers for spaces that
are enabled in `.mind/config.yml`.

Example MCP tool usage (for agents):

```json
{
  "name": "memory_query",
  "arguments": {
    "space": "Credentials",
    "search": "query terms",
    "from": "2026-03-01",
    "to": "2026-03-31",
    "limit": 25,
    "offset": 0
  }
}
```

Stage 1 MCP structured tools now return the same payload in two forms:

- `structuredContent` for agents that consume structured data directly
- one raw YAML `content` text item serialized from that same payload (no markdown fences)

In this stage, `system_instructions` and the content-only delete/link tools keep their existing text responses.

`memory_query` supports optional `search` for full-text search and returns pagination fields such as `limit` and `offset` in both `structuredContent` and YAML content. Its optional `tier` field also accepts `null`, which means the same thing as omitting the tier filter (all tiers).

Memory MCP workflows also support bounded composite ergonomics while keeping atomic tools:

- `memory_add` supports optional `pinned` and `links_to` (best-effort — check `links_failed` in response).
- `memory_read` returns directional linked summaries via `links_to` and `linked_by` with high-signal fields (`name`, `changed_at`, `tier`, `tags`, `pinned`, `ref`). Use `noPromote:true` to read without side effects.
- Memory MCP payloads use `changed_at` and do not expose `access_count`,
  `last_accessed_at`, `created_at`, or `updated_at`.

`space_get` now returns an orientation summary for one space:

- `overview` with total memory count, active checkpoint count, and per-tier
  counts
- `trending_memories` grouped into `tier_1`, `tier_2`, and `tier_3`, ranked by
  `changed_at`
- per-tier `coverage` metadata so agents can tell whether each preview is
  complete or only a subset
- plural `active_checkpoints` with checkpoint items matching `checkpoint_query`

Checkpoint MCP tools are also available for session continuity:

- `checkpoint_save`
- `checkpoint_done`
- `checkpoint_load`
- `checkpoint_query`

`checkpoint_load` requires `checkpointName` (use `checkpoint_query` first to find available checkpoints). It returns full checkpoint text fields plus all linked_memories in enriched format, and checkpoint MCP payloads use `changed_at` instead of `created_at` / `updated_at`.

`checkpoint_query` returns full pending text (no preview truncation) and includes an explicit `error` field (`null` on success, `{ code, message }` when the requested space is missing).

System tools for agent protocol:

- `system_instructions` — returns the complete mind usage protocol
- `status` — get storage status

### Agent integration details

Use the commands in [Installation](#installation) to run setup. This section
explains how to read the capability matrix and what each integration actually
configures.

`mind setup` (without agent) now prints a capability matrix per integration using a 3-level model:

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

| **Agent**   | **Status** | **Capability reality**                                        |
| :---------- | :--------- | :------------------------------------------------------------ |
| OpenCode    | Complete   | L1 `supported`, L2 `supported`, L3 `supported`                |
| Claude Code | Complete   | L1 `supported`, L2 `supported`, L3 `supported` (opt-in hooks) |
| Codex       | Partial    | L1 `supported`, L2 `supported`, L3 `unsupported`              |
| Cursor      | Partial    | L1 `supported`, L2 `unverified`, L3 `supported`               |
| Windsurf    | Partial    | L1 `supported`, L2 `unsupported`, L3 `unsupported`            |
| Gemini CLI  | Partial    | L1 `supported`, L2 `unsupported`, L3 `unsupported`            |
| VSCode      | Partial    | L1 `supported`, L2 `unsupported`, L3 `unsupported`            |
| Antigravity | Partial    | L1 `supported`, L2 `unsupported`, L3 `unsupported`            |

Rollout policy:

- Wave 1 priority agents: **OpenCode, Claude Code, Gemini CLI, Cursor**
- Claude Code now includes managed **L2 protocol injection** by writing `~/.claude/instructions/mind-memory-protocol.md` and maintaining a managed block in `~/.claude/CLAUDE.md`
- Claude Code **L3 hooks automation is opt-in and non-blocking** (default off). Enable with `MIND_SETUP_CLAUDE_ENABLE_HOOKS=true` before running setup.
- Cursor **L2** remains intentionally **unverified** (no verified global user-rules injection path)
- Cursor **L3** is implemented with global hooks wiring (`~/.cursor/hooks.json` + managed hook script)
- Existing integrations outside Wave 1 remain wired in the same capability model with explicit status
- Antigravity is now a **supported** agent with L1 MCP wiring and skill installation at `~/.gemini/antigravity/`

`mind setup opencode` is idempotent and non-destructive:

- preserves unknown keys already present in `~/.config/opencode/opencode.json`
- configures `mcp.mind` as local command transport (`type: "local"`, `command: ["<path-to-mind>", "mcp"]`)
- writes/refreshes `~/.config/opencode/instructions/mind-memory-protocol.md`
- ensures that instruction file is present in OpenCode's `instructions` list
- configures prudent L3 session/compaction automation by default and non-blocking, writing `~/.config/opencode/plugins/mind-automation.js` during setup

`mind setup codex` keeps setup idempotent and writes local MCP command args in `~/.codex/config.toml`:

- `[mcp_servers.mind]`
- `command = "<path-to-mind>"`
- `args = ["mcp"]`

It also non-destructively upserts a managed Memory Protocol block in `~/.codex/AGENTS.md`.

`mind setup cursor` keeps existing MCP setup behavior and now configures global L3 continuity hooks:

- writes/updates `~/.cursor/hooks.json` with managed idempotent entries for `sessionStart`, `preCompact`, and `stop`
- writes/refreshes executable hook script `~/.cursor/hooks/mind-session-continuity.sh`
- preserves existing hook config keys/entries

Check server process status:

```bash
mind server-status
```

### Update

mind can update itself from GitHub Releases:

```bash
mind update --check                 # check if a newer release exists
mind update                         # update to latest release
mind update --version v0.1.0        # update to a specific tag
```

## Data Storage

Mind stores its primary database in SQLite and can also keep optional
autosync files in a versioned `.mind/` directory.

- Default DB path: `data/mind.db`
- Optional autosync config and exported files: `.mind/`
- Override directory: `MIND_DATA_DIR=/custom/path`
- Override full DB path: `MIND_DB_PATH=/custom/path/mind.db`

Legacy migration:

```bash
mind import
```

## Project Structure

```text
src/
  cli/        # CLI parser, command registry, setup/runtime helpers
  mcp/        # MCP command + MCP server + tools
  api/        # HTTP command, router, route modules, API server
  helpers/    # logger, tags, format, rag helpers
  sync/       # autosync config, import/export, conflicts, file watcher
  store/      # SQLite schema + MindStore implementation
  mind.ts     # main entrypoint used by mind

test/        # backend/CLI tests

web/src/      # frontend runtime modules (ESM, no build step)
web/styles/   # split CSS (tokens/base/layout/components/utilities)
web/assets/   # static assets (logo, images)
web/public/   # SPA HTML shell (index.html)
web/test/     # web-only tests
```

## Testing

Run unit tests:

```bash
bun test test/ web/test
```

Run web-only tests:

```bash
bun test web/test
```

Run RAG integration test (requires `OPENAI_API_KEY`):

```bash
make test-rag
```

## Maintainers: Releases

Release management is handled via `Makefile`:

```bash
make help
make release-patch
make release-minor
make release-major
make release-simulate TYPE=patch
```

`release-simulate` runs a full release simulation without changing files, creating tags, or publishing a release.

## Contributing

Issues and PRs are welcome.

- Keep changes focused and documented.
- Preserve command behavior and compatibility when possible.
- Update `AGENTS.md` when architecture or command behavior changes.

## License

[MIT](./LICENSE)

For release history, see [CHANGELOG.md](./CHANGELOG.md).
