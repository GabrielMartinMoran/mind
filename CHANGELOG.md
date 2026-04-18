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

- `Added \\`mind update --check\\` to verify available releases without installing.`

## [Unreleased]

### Added

- **`sync serve --detached`** — Background file watcher mode (like `mind serve --detached`) with PID file at `data/mind-sync-watch.pid`
- **`sync stop`** — Command to stop the detached sync watcher process
- **`sync init --path <dir>`** — Initialize `.mind/` in a custom directory instead of cwd
- **`sync enable --path <dir>`**, **`sync now --path <dir>`**, **`sync export --path <dir>`**, **`sync import --path <dir>`** — Custom `.mind/` path override via `--path` flag
- **`links_to` import** — When importing markdown files, links from frontmatter are now created as actual links in the DB (cross-space refs like `projects/other:memory-name` are supported; missing targets are logged as warnings)
- **`sync status --space <name>`** — Detailed stats view showing enabled status, watcher status (running/stopped), memory count, sync file count, conflict strategy, and path
- **`MIND_SYNC_ROOT` env var** — MCP server respects this env var to find `.mind/` when running from a different directory than the project
- **`mind mcp --sync-root <path>`** — MCP server accepts `projectRoot` parameter in both `startMcpServer()` and `startMcpHttpServer()` for explicit project root override
- **FileWatcher auto-restart** — If the watcher encounters an error (e.g., directory deleted), it automatically restarts up to 3 times with a 5 second delay between attempts

### Changed

- **Autosync** — Complete rewrite to file-based config (`.mind/config.yml`) instead of SQLite table
  - Config is now versioned with git for team collaboration
  - Spaces stored in `.mind/spaces/<hash>/` directories
  - Hash = SHA256 truncated to 8 hex chars
  - CLI commands: `sync init`, `sync status`, `sync enable`, `sync disable`, `sync now`, `sync export`, `sync import`, `sync conflict`, `sync remove`, `sync config`, `sync serve`
  - MCP server auto-starts watchers for all enabled spaces

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
