# AGENTS.md — Project guide for AI agents and maintainers

This document describes the **mind** project: its architecture, behavior, technical choices, and how to use it. It is intended for AI agents and human maintainers. **Agents that modify this codebase must keep this file updated** when they change architecture, add commands, change config, or alter behavior (see [Keeping this document updated](#keeping-this-document-updated)).

---

## 1. Project overview

**mind** is a CLI tool for persistent long-term memory — tracking thoughts, ideas, tasks, and knowledge. Data is organized into named **spaces**, each containing **memories** with full-text search, tags, links, and a 3-tier CPU-cache-style access-frequency system.

- **Runtime:** [Bun](https://bun.sh/)
- **Language:** TypeScript (strict mode, ESNext)
- **Entry point:** the **`mind`** Bash script at project root; invokes `src/mind.ts`. Supports subcommands: `serve` (HTTP server), `mcp` (MCP server), `setup` (agent configuration), and `update` (self-update from GitHub releases). Also supports `--complete` flag to delegate to `src/complete.ts` (not yet implemented).
- **Persistence:** SQLite database at `data/mind.db` (path configurable via `MIND_DATA_DIR` env var or `MIND_DB_PATH` for full path override). The legacy `brain.json` is supported as a migration source via `mind import`.
- **RAG/Embeddings:** Optional semantic search via OpenAI `text-embedding-3-small`. Enable with `MIND_RAG=true` + `OPENAI_API_KEY`. Embeddings stored as BLOBs in SQLite; generated fire-and-forget on add/update.
- **Layout:** **`src/`** contains CLI, MCP, and API server code. **`test/`** contains backend/CLI tests. **`web/`** contains frontend source (`web/src`), styles (`web/styles`), static assets (`web/assets`), static HTML shell (`web/public`), and web-specific tests (`web/test`). **`scripts/`** contains E2E test scripts.
- **Neural Map MVP:** web SPA includes a read-only per-space graph view using a minimal graph API payload and on-demand memory detail fetch, with deterministic best-effort anti-overlap placement, 25-char visible label truncation (full name retained via accessibility/tooltip), and higher zoom ceiling for dense maps.
- **Web SPA URL routing:** client-side URL contract is `/'` (home) and `/spaces/{encodedSpace}?view=list|map&memory={encodedMemory?}` with reload restore, browser back/forward support (`popstate`), and safe fallback canonicalization when route params are invalid.

---

## 2. Architecture

### 2.1 High-level flow

```
User → ./mind <command> [args] [--flag value]
         ↓
    mind (Bash script at repo root)
         ↓
    bun run src/mind.ts "$@"
         ↓
    executeCommand(args, store, logger)
         ↓
    CLI command registry (atomic command modules) → command-executor (dispatch)
         ↓
    MindStore (SQLite) + Logger (stdout/stderr)
```

- **Entry:** `src/mind.ts` creates store/logger and delegates all command handling to `executeCommand` from `src/cli/command-executor.ts`.
- **Commands:** Declared as atomic modules in `src/cli/commands/*.ts` and registered by `src/cli/commands/index.ts`. `src/cli/command-executor.ts` acts as dispatcher/registry.
- **Storage:** All persistent data goes through the `MindStore` interface (defined in `src/store/mind-store.ts`), implemented by `createSqliteStore` (`src/store/sqlite-store.ts`). Uses bun's native `bun:sqlite`.
- **FTS:** Full-text search uses SQLite's FTS5 with a porter tokenizer. FTS is synced **manually** (bun:sqlite has a bug with content-sync triggers — see [§ 3](#3-technical-considerations)).
- **Output:** All user-facing messages go through the `Logger` interface (`src/helpers/logger.ts`), so tests can swap in a mock logger.
- **Web/API:** The single canonical HTTP server is `src/api/server.ts` (via `mind serve`), and it serves API routes plus static web files from the `web/` tree.

### 2.2 Main modules and responsibilities

| Module                | Path                                                                 | Responsibility                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| --------------------- | -------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Entry script          | `mind` (Bash)                                                        | Resolve repo root, dispatch to `src/mind.ts`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| Entry module          | `src/mind.ts`                                                        | Bootstrap store/logger and run CLI command executor.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| CLI command modules   | `src/cli/commands/*.ts`                                              | Atomic command definitions/handlers grouped by domain (`spaces`, `memories`, `tiers`, `links`, `search`, `status`, `tags`, `checkpoint`, `guide`, `migration`, `runtime`).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| CLI executor          | `src/cli/command-executor.ts`                                        | Load command groups from `src/cli/commands/index.ts`, dispatch matched command, and render help sections.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| Arg parser            | `src/cli/arg-parser.ts`                                              | Match CLI args to a shape (positional `<param>`, aliases `a\|b`, `--flag value`), extract params + flags, render help.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| Setup/runtime helpers | `src/cli/setup.ts`                                                   | Agent setup, detected integration refresh, and detached process management helpers for MCP/web servers. Uses a capability-driven adapter model (L1 MCP, L2 instruction injection, L3 hooks automation) with explicit status (`supported`/`unsupported`/`unverified`) and visible fallback diagnostics. OpenCode/Claude/Codex L2 protocol injection now renders from a single canonical template source at setup-time (agent-specific wording via internal renderer), while preserving idempotent/non-destructive managed-file behavior. Cursor setup preserves existing L1/L3 behavior and provisions global L3 hooks automation via managed `~/.cursor/hooks.json` entries and managed executable script artifacts in `~/.cursor/hooks/`. All reads and writes of user-owned agent config files go through the safe-config helpers in `src/setup/safe-config.ts` so parse failures abort the run and content changes are backed up and atomic. |
| Safe config I/O       | `src/setup/safe-config.ts`                                           | `readJsonOrThrow` / `readJsoncOrThrow` parse existing JSON/JSONC strictly and throw `MalformedConfigError` on failure (callers abort). `backupIfExists` produces timestamped sibling backups before content-changing writes. `atomicWriteText` / `safeWriteJson` / `safeWriteJsonc` stage writes in a sibling `.tmp` file and rename them into place. `safeWriteJsonc` uses `jsonc-parser.modify` to preserve comments and formatting when only existing top-level keys are modified. Backups are not pruned.                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| Shared helpers        | `src/helpers/*.ts`                                                   | Shared helpers: logger, tag normalization, formatting/memory refs, markdown resource loading, RAG helpers, shared memory-ref resolution (`resolveRefWithFallback`), link-building (`buildLinkedMemoriesArray`, `mapLinkedSummariesToLinksFormat`, `transformLinkedSummary`), and checkpoint-content (`buildCheckpointContent`, `fetchCheckpointContent`).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| MindStore interface   | `src/store/mind-store.ts`                                            | Abstract interface for all data operations.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| SQLite store          | `src/store/sqlite-store.ts`                                          | Full `MindStore` implementation using `bun:sqlite`. Uses repository factory pattern internally (6 repositories in `src/store/repositories/`). Handles tiers, LRU eviction, tags, links, FTS, status, import. Generates embeddings in background when RAG enabled.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| Store repositories    | `src/store/repositories/*.ts`                                        | 6 focused repositories: `SpaceRepository`, `MemoryRepository`, `LinkRepository`, `TagRepository`, `LogRepository`, `SearchRepository`. Composed by `sqlite-store.ts` into the full MindStore.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| Migration safety      | `src/store/migration-safety.ts`                                      | Opens SQLite databases through the automatic migration safety wrapper. Existing outdated DBs are backed up with `VACUUM INTO`, migrated, validated, restored on migration/validation failure, and pruned to the latest 3 automatic backups per DB path. Fresh/current DBs don't create migration backups.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| Schema                | `src/store/schema.ts`                                                | SQLite schema (tables, indexes, FTS5 table). No triggers (see §3). `initializeDatabase()` function. Schema version 8 (migrates v1→v2→v3→v4→v5→v6→v7→v8).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| MCP server            | `src/mcp/server.ts`                                                  | MCP stdio server using `@modelcontextprotocol/sdk`. Exposes tools across spaces, memories, links, checkpoints, and system categories.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| MCP tools             | `src/mcp/tools/`                                                     | Tool declarations and wiring only: `spaces.ts`, `memories.ts`, `links.ts`, `checkpoint.ts`, `status.ts`, `system.ts`. Endpoint schemas live in `src/mcp/schemas/<family>/<endpoint>.ts`, endpoint handlers live in `src/mcp/handlers/<family>/<endpoint>.ts`, and MCP-only helpers (including YAML parity + JSON-schema conversion) live in `src/mcp/helpers/`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| API server            | `src/api/server.ts`                                                  | Bun HTTP server that serves `/api/*` routes and static web files from `web/` (SPA shell in `web/public/index.html`, frontend modules in `web/src`, styles in `web/styles`, assets in `web/assets`).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| API router            | `src/api/router.ts`                                                  | Route matcher/dispatcher for API endpoints.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| API routes            | `src/api/routes/*.ts`                                                | Atomic REST route declarations grouped by domain (`spaces`, `memories`, `search`, `status`, `logs`).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| Config                | `src/config.ts`                                                      | `CONFIG.dataDir`, `CONFIG.dbPath`, `CONFIG.legacyJsonPath`, `CONFIG.rag`. Respects `MIND_DATA_DIR` and `MIND_DB_PATH` env vars. `TIER_LIMITS` per-tier capacity constants.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| Types                 | `src/types.ts`                                                       | All domain types: `Space`, `Memory`, `Link`, `Tier`, `SearchResult`, `StatusResult`, `LegacyBrain`, etc.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| Helpers               | `src/helpers/*.ts`                                                   | Shared helpers: logger, tag normalization, formatting/memory refs, markdown resource loading, and RAG helpers.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| Protocol resources    | `src/resources/protocols/*.md`                                       | Canonical markdown sources for OpenCode setup protocol injection and MCP `system_instructions` tool content.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| Sync (Autosync)       | `src/sync/`                                                          | Bidirectional file sync with file-based config: `ConfigFileService` (read/write `.mind/config.yml`), `FileSyncService` (manifest v2 DB→FS export and managed pruning), `SyncCoordinator` + `withAutoExport` (non-blocking auto-export decorator for CLI/API/MCP store mutations), `AutoSyncService` (file watcher/import), `importer` (shared file-to-DB import with metadata parity), `status-diagnostics` (manifest/filesystem/DB drift evaluation), `ConflictResolver` (db-wins/file-wins/latest-wins), `FileWatcher`, `Frontmatter`, and `Normalizer`. Spaces live in `.mind/spaces/<hash>/` where hash = SHA256 truncated to 8 hex chars. Manifest v2 stores canonical content/metadata hashes and UTC timestamps for baseline dirty detection. Loop prevention uses per-space DB-origin locks in `.mind/spaces/<hash>/.mind-sync/.syncing`. MCP server auto-starts watchers for enabled spaces.                                           |
| Web frontend          | `web/src/*`, `web/styles/*`, `web/assets/*`, `web/public/index.html` | SPA for browsing and editing spaces and memories. Frontend runtime code is modular ES modules in `web/src/` (no build pipeline), with `@ts-check` + JSDoc in key modules, split styles in `web/styles/`, static assets in `web/assets/`, and URL-driven client routing for deep links/reload/back-forward restoration.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |

Neural Map API/UI touchpoints:

- `GET /api/spaces/:space/graph?limit=<n>` (implemented in memory routes)
- `MindStore.getSpaceGraph(space, opts)` backed by SQLite implementation
- SPA view toggle (`List` / `Neural Map`) with concentric tier rings (T1..T3), anchored pan/zoom (higher max zoom cap), deterministic best-effort overlap mitigation, truncated visible labels (25 chars + ellipsis), and click-to-fetch details via existing memory detail endpoint
- SPA URL contract and state sync for space/view/memory: `/`, `/spaces/{encodedSpace}`, `view=list|map`, optional `memory={encodedMemory}`

### 2.3 Data model

- **Brain:** A SQLite database (`mind.db`) at `data/` in the repo root (or `MIND_DATA_DIR`).
- **Space:** `{ id: string (UUID), name: string, description: string, hidden: boolean, tags: string[], created_at, updated_at }`. Identified by name (unique); UUID primary key for internal references.
- **Hidden spaces:** Spaces can be marked hidden and are omitted from default `list`; include them with `list --hidden`.
- **Checkpoints:** Session checkpoints are stored as tagged memories (`checkpoint` tag) in the same project space.
- **Memory:** `{ id: string (UUID), space_name: string, name: string, content: string, tier: 1|2|3, pinned: boolean, access_count: number, last_accessed_at: string|null, tags: string[], embedding: Float32Array|null, created_at, updated_at, changed_at }`. UUID primary identity; `fts_id` (number) is the SQLite FTS5 surrogate. Identified by `(space_name, name)`.
- **Tier system:**
  - 🔴 **T1 (hot)** — frequently accessed (limit: 25/space)
  - 🟡 **T2 (warm)** — default for new memories (limit: 50/space)
  - 🔵 **T3 (cold)** — rarely used (unlimited capacity)
  - Auto-promotion on CLI `read`: each read promotes one tier up (T3→T2, T2→T1). Skipped silently if pinned or if destination is full and all are pinned.
  - **LRU eviction:** when a tier is full, the least-recently-used non-pinned memory is demoted one tier down (no cascading). T3 is unlimited, so no eviction from T3. If all memories in a tier are pinned, `addMemory` and `promote` throw an error; `recordAccess` promotion silently skips.
  - New memories can be added to T1, T2, or T3 only.
  - **Pinned memories are immune to auto-promotion and LRU eviction.**
- **Link:** Directional edge between two memories with a label (default: `"related"`). Stored as `(source_id TEXT, target_id TEXT, label)` (UUID foreign keys).
- **Tags:** Both spaces and memories can have multiple string tags. Tags are normalized on input: converted to lowercase, leading `#` stripped, validated against allowed characters (`a-z`, `0-9`, `-`, `_`, `.`, `:`, `/`, `=`, `+`, `@`). Tags cannot be empty or contain spaces. Displayed with `#` prefix in CLI output.
- **FTS:** `memories_fts` virtual FTS5 table, synced manually on add/update/delete. Supports fuzzy matching via porter tokenizer.
- **Hybrid retrieval (RAG-enabled):** Search uses deterministic weighted normalized hybrid ranking over FTS relevance and semantic similarity when both are available. If FTS returns no rows, semantic fallback applies a minimum similarity threshold before returning results. With RAG disabled, behavior remains FTS-compatible.

### 2.4 SQLite schema tables

| Table             | Key columns                                                                                                                                                                                                                                             | Notes                                                                                                                    |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `meta`            | `key`, `value`                                                                                                                                                                                                                                          | Tracks `schema_version`.                                                                                                 |
| `spaces`          | `id` (TEXT PK), `name` (UNIQUE), `description`, `hidden`, timestamps                                                                                                                                                                                    | UUID primary identity.                                                                                                   |
| `space_tags`      | `space_name` (FK), `tag`                                                                                                                                                                                                                                | Cascades on space rename/delete.                                                                                         |
| `memories`        | `id` (TEXT PK), `space_id` (TEXT FK → spaces.id), `name`, `content`, `tier` (CHECK `tier BETWEEN 1 AND 3`), `pinned`, `access_count`, `last_accessed_at`, `embedding`, `fts_id` (INTEGER UNIQUE), timestamps (`created_at`, `updated_at`, `changed_at`) | UUID primary identity; `fts_id` is SQLite FTS5 surrogate. UNIQUE on `(space_id, name)`. Cascades on space delete/rename. |
| `memory_tags`     | `memory_id` (TEXT FK), `tag`                                                                                                                                                                                                                            | Cascades on memory delete.                                                                                               |
| `links`           | `source_id` (TEXT FK), `target_id` (TEXT FK), `label`                                                                                                                                                                                                   | No self-links. Cascades on memory delete.                                                                                |
| `idx_*`           | `idx_memories_space_id`, `idx_memories_fts_id`, `idx_memories_space_id_name`, `idx_spaces_id`                                                                                                                                                           | Performance indexes for lookups.                                                                                         |
| `memories_fts`    | FTS5 virtual table: `name`, `content`                                                                                                                                                                                                                   | Synced manually (no triggers).                                                                                           |
| `fts_id_sequence` | `entity` (TEXT PK), `next_value` (INTEGER)                                                                                                                                                                                                              | Transactional FTS5 surrogate ID assignment.                                                                              |
| `logs`            | `id` (PK), `source`, `operation`, `level`, `input_data`, `output_data`, `error_message`, `caller_info`, `duration_ms`, `timestamp`                                                                                                                      | Operation audit logging (fire-and-forget).                                                                               |

---

## 3. Technical considerations

- **Schema version:** Current schema is version 8. Existing v1 databases (tier `CHECK (tier BETWEEN 1 AND 3)`) are migrated automatically via a 12-step rename-and-recreate pattern in `MIGRATE_V1_TO_V2`. V2→V3 adds the `embedding BLOB` column. V3→V4 adds `changed_at` and backfills it from `updated_at`. V4→V5 adds `spaces.hidden` with default `0`. V5→V6 adds the `logs` table for operation auditing. V6→V7 removes T4 (frozen) tier; all T4 memories migrate to T3 which becomes unlimited. V7→V8 converts `spaces` and `memories` from INTEGER AUTOINCREMENT to UUID TEXT primary keys, adds `memories.fts_id` (INTEGER) as local surrogate for SQLite FTS5 rowid, adds `memories.space_id` (TEXT FK) normalizing the relationship to `spaces`, adds `spaces.id` (TEXT PK), and adds the `fts_id_sequence` table for transactional ID assignment.
- **Migration safety:** Store initialization detects existing DB schema version before migration. If the DB exists and is outdated, mind creates an automatic `*.migration-backup.*.db` backup with SQLite `VACUUM INTO`, runs migrations, validates the final schema version, `PRAGMA quick_check`, and `PRAGMA foreign_key_check`, and restores the backup if migration or validation fails. Fresh/current DBs skip migration backups, and automatic migration backups are pruned to the latest 3 per DB path.
- **Bun:** The project is run and tested with Bun. Use `bun run`, `bun test`, and Bun's built-in TypeScript + SQLite support. No separate compile step.
- **bun:sqlite FTS5 bug:** bun:sqlite (v1.2.10) cannot handle FTS5 `content=table` sync triggers — any UPDATE or DELETE on the source table errors with "N values for M columns". **Workaround:** `memories_fts` is a standalone FTS5 table (no `content=` option, no triggers). FTS is synced manually in `sqlite-store.ts` via `ftsInsert`, `ftsUpdate`, `ftsDelete` helpers called from `addMemory`, `updateMemory`, `deleteMemory`, `deleteMemoryByName`, `deleteSpace`, and `importFromJson`.
- **Styling:** Terminal output uses `bun-style` for bold, colors, etc. Tests assert on the styled strings.
- **Config / storage path:** `src/config.ts` resolves `CONFIG.dbPath` from `MIND_DB_PATH` env var (full path override) or `MIND_DATA_DIR` env var + `mind.db` (defaults to `data/` at repo root). The web server uses `MIND_DATA_DIR` (or `/data` in Docker). `data/` is in `.gitignore`. HTTP idle timeouts are configurable via `MIND_MCP_IDLE_TIMEOUT` (default 120s) and `MIND_API_IDLE_TIMEOUT` (default 30s). Log retention is configurable via `MIND_LOG_RETENTION_MINUTES` (default 10080 minutes = 7 days). Web server port is controlled via `MIND_PORT` (default: 30303).
- **Setup capability model:** each agent adapter declares L1 (MCP), L2 (instruction/protocol injection), and L3 (hooks/session automation) with status `supported`, `unsupported`, or `unverified`, plus confidence/evidence/fallback notes printed during `mind setup` flows. All agents now use stdio transport (command + args) for MCP wiring, not HTTP URL. No silent capability skip.
- **Setup refresh behavior:** `mind setup refresh` refreshes detected mind-managed integrations by default without creating unrelated first-install configs. Detection includes existing mind MCP config/stanza, managed protocol file/block, managed hook/plugin/script, or installed mind-management skill signal. `--dry-run`, `--all`, and `--agent <agent>` are available. After a successful installer run, `mind update` first runs the newly installed `mind status` when a DB existed before the update to force automatic migration/restore, then runs detected integration refresh unless `--no-refresh-integrations` is passed. Fresh installs with no DB skip the status step to avoid creating a DB.
- **Claude setup behavior:** `mind setup claude-code` deep-merges `~/.claude/settings.json`, writes/refreshes `~/.claude/instructions/mind-memory-protocol.md`, and upserts a managed block in `~/.claude/CLAUDE.md` pointing to that protocol. Managed-block/hook wiring now self-heals dirty duplicate entries on reruns, and setup removes known legacy per-agent protocol files to prevent regressions. L3 hook automation is opt-in (`MIND_SETUP_CLAUDE_ENABLE_HOOKS=true`) and non-blocking; failures fall back to manual workflow guidance.
- **Capability declarations beyond wired adapters:** VSCode and Antigravity are fully supported agents.
- **OpenCode setup behavior:** `mind setup opencode` deep-merges existing JSON config (preserving unknown keys), configures `mcp.mind` as local command transport (`type: "local"`, `command: ["<path-to-mind>", "mcp"]`), writes/refreshes `~/.config/opencode/instructions/mind-memory-protocol.md`, and ensures that exact path is present exactly once as the first entry in the OpenCode `instructions` list. Reruns sanitize dirty instruction lists (dedupe + remove known legacy protocol paths/files). L3 prudent session/compaction automation is default-on and non-blocking: setup writes a managed plugin at `~/.config/opencode/plugins/mind-automation.js` that handles `session.created`, `session.compacted`, compaction continuity, and prudent session-end summaries with deterministic caps/idempotency. The generated plugin default-exports an OpenCode V2 definition (`id` + `setup`, using `ctx.session.hook('context'|'compaction')` and `ctx.event.subscribe`) and also exposes V1 `server()` hooks, so it loads on both V1 and V2 runtimes.
- **OpenCode JSONC support:** `mind setup opencode` prefers `~/.config/opencode/opencode.jsonc` over `opencode.json` when both exist, never creates `opencode.json` if `opencode.jsonc` is already present, and creates a new file as `opencode.jsonc` (the JSONC superset of JSON that OpenCode accepts natively). The setup uses `jsonc-parser` to parse existing JSONC and to apply edits that preserve comments and formatting when only existing top-level keys are modified. Files that mix JSONC (e.g. with comments or trailing commas) and standard JSON are both supported.
- **Setup file safety (parse-safely / backup / atomic write):** All setup flows that touch a user-owned agent config file (JSON, JSONC, and TOML) now go through `src/setup/safe-config.ts`. JSON/JSONC covers opencode, claude fallback, cursor, windsurf, gemini-cli, vscode, and antigravity. TOML covers codex (`~/.codex/config.toml`), backed by `Bun.TOML.parse` with a feature-detect guard (no TOML npm dependency) and a new `safeWriteToml` helper that mirrors the JSON/JSONC contract. The contract is: existing files are parsed strictly, and a parse failure aborts the entire setup run with a clear error rather than overwriting the file with an empty default. Content-changing writes are preceded by a timestamped sibling backup (`<file>.bak.YYYYMMDDTHHMMSSmmmZ`) holding the pre-write bytes, and the new content is staged in a sibling `.tmp` file and renamed into place so a crash mid-write cannot leave a partial file. Backups are intentionally not pruned by setup — users can manage them by hand. The same contract applies to `mind setup refresh` and to the post-update integration refresh path. `MalformedConfigError.parser` is now `'json' | 'jsonc' | 'toml'` so callers can branch on the parser without losing type safety.
- **Cursor setup behavior:** `mind setup cursor` deep-merges `~/.cursor/mcp.json` for L1 MCP and configures global managed L3 hooks in `~/.cursor/hooks.json` (events: `sessionStart`, `preCompact`, `stop`) backed by an executable managed script at `~/.cursor/hooks/mind-session-continuity.sh`. Hook setup deduplicates dirty managed entries on reruns and remains non-blocking with explicit safe fallback messaging.
- **Codex setup behavior:** `mind setup codex` writes a local MCP stanza in `~/.codex/config.toml` with `command = "<path-to-mind>"` and `args = ["mcp"]` (stdio/local transport, no forced HTTP args), and upserts a managed protocol block in `~/.codex/AGENTS.md` non-destructively. Reruns collapse duplicate managed blocks and remove known legacy per-agent protocol files. The Codex write path now goes through the TOML-aware safe-config pipeline (`readTomlOrThrow` + `safeWriteToml` in `src/setup/safe-config.ts`, backed by `Bun.TOML.parse` with a feature-detect guard — no TOML npm dependency): existing files are parse-validated before any write, malformed TOML aborts the run without overwriting, content-changing writes are backed up, an outdated `[mcp_servers.mind]` stanza is replaced in place (preserving unrelated tables and comments), and a missing stanza is appended. `isAgentIntegrationDetected('codex')` dispatches on `cfg.format` and uses `tomlFileHasMindMcp` for TOML agents so the detector no longer probes `config.toml` with `JSON.parse`.
- **Protocol sources:** Setup L2 managed protocol payloads for OpenCode/Claude/Codex are rendered from the canonical template `src/resources/protocols/mind-memory-protocol.template.md` using `src/helpers/template-renderer.ts` and `src/cli/memory-protocol.ts`. MCP `system_instructions` is rendered through the same canonical template pipeline by `src/cli/system-instructions.ts` from `src/resources/protocols/mind-system-instructions.md` (empty-context render for deterministic text output). The template renderer operates in strict mode: unresolved placeholders/conditionals (or leftover template tokens) throw errors for all render paths.
- **MCP YAML stage 1:** Structured MCP tools now return one raw YAML text item serialized directly from the same payload exposed via `structuredContent`. This is built through `src/mcp/helpers/yaml-response.ts` (not hidden in `src/mcp/server.ts`). Stage-1 exclusions remain text-only: `system_instructions`, `space_delete`, `memory_delete`, `link_create`, and `link_delete`. `checkpoint_query` includes an explicit `error` field (`null` on success, `{ code, message }` on soft error), returns full `pending` text without preview truncation, memory/checkpoint MCP payloads rely on `changed_at` instead of exposing `created_at` / `updated_at`, memory MCP payloads also omit `access_count` / `last_accessed_at`, and `space_get` now returns an orientation summary with `overview`, changed-at `trending_memories` blocks per tier, and plural `active_checkpoints` whose checkpoint items reuse the `checkpoint_query` shape.
- **Testing:** Backend/CLI tests live in `test/`. Web-specific tests live in `web/test/`. Both use `bun:test` and rely on:
  - **`test-store.ts`** (`test/mocks/test-store.ts`): creates a temporary SQLite DB in `/tmp/` per test instance; returns `{ store, cleanup }`.
  - **`mocked-logger.ts`** (`test/mocks/mocked-logger.ts`): captures `logInfo`/`logError` for assertions.
  - Backend/CLI test files include: `test/mind-store.spec.ts` (store-level, including graph retrieval), `test/migration-safety.spec.ts` (automatic migration backup/restore/retention), `test/api-routes.spec.ts` (HTTP route-level behavior), `test/command-executor.spec.ts` (CLI-level), `test/mcp-tools.spec.ts` (MCP tools), `test/mcp-yaml-content.spec.ts` (stage-1 YAML parity + exclusions), `test/setup-safe-config.spec.ts` (safe config I/O: parse-failure abort, backup, atomic write, JSONC with comments/trailing commas), `test/setup-opencode.spec.ts` (OpenCode JSONC preference + safe writes + parse-failure abort), `test/setup-capabilities.spec.ts` (cross-agent safe writes + parse-failure abort),, `test/memory-protocol-renderer.spec.ts`, `test/system-tools.spec.ts`, `test/template-renderer.spec.ts`, and `test/arg-parser.spec.ts`.
  - Web test files include: `web/test/neural-map-graph-math.spec.ts` (Neural Map zoom/layout/label math), `web/test/spa-routing.spec.ts` (URL contract parse/build), `web/test/memory-panel-interactions.spec.ts` (panel close/drag guard behavior), and `web/test/web-index-assets.spec.ts` (deep-route-safe asset paths).
  - **`scripts/test-rag.sh`**: E2E integration test for RAG. Requires `OPENAI_API_KEY`, makes real OpenAI API calls. Uses `MIND_DB_PATH` to create a temp DB. Run via `make test-rag` or directly.
- **Docker:** `web/Dockerfile` builds the web app; `docker-compose.yml` runs it with volume `./data` (or `BRAIN_DATA_DIR`) mounted at `/data`, port 3000, and `restart: unless-stopped`.
- **Dependencies:** Production: `bun-style`, `jsonc-parser`, `yaml`. Dev: `@types/bun`. Peer: `typescript ^5`.
- **Shell completion:** The `mind` bash script supports `--complete` flag, delegating to `src/complete.ts`. This file is **not yet implemented**.

---

## 4. Usage

### 4.1 Setup

```bash
bun install
```

### 4.2 Running the CLI

From the project root:

```bash
./mind <command> [args] [--flag value]
```

Example: `./mind help`, `./mind create my-space "Description"`, `./mind search "auth" --tier 1`.

The `data/` directory and `mind.db` are created automatically on first run.

### 4.3 Running the Web Server

```bash
./mind serve start                  # Start HTTP server on port 3000
./mind serve start --port 8080      # Custom port
./mind serve start --detached       # Run in background
./mind serve stop                   # Stop detached server
```

### 4.4 Running the MCP Server

```bash
./mind mcp                          # Start MCP server (stdio transport)
./mind mcp start --http             # Start MCP over HTTP (foreground)
./mind mcp start --http --detached  # Start MCP over HTTP (background)
./mind mcp stop                     # Stop detached MCP server
```

Add to your agent's MCP config:

**OpenCode** (`~/.config/opencode/opencode.jsonc`, or `opencode.json` if only the legacy file exists):

```json
{
  "mcp": {
    "mind": {
      "type": "local",
      "command": ["/absolute/path/to/mind", "mcp"],
      "enabled": true
    }
  },
  "instructions": ["~/.config/opencode/instructions/mind-memory-protocol.md"]
}
```

**Claude Code** (`~/.claude/settings.json`):

```json
{
  "mcpServers": {
    "mind": {
      "command": ["/path/to/mind", "mcp"],
      "enabled": true
    }
  }
}
```

### 4.5 Setting up agents

```bash
./mind setup claude-code   # Auto-configure Claude Code
./mind setup opencode      # Auto-configure OpenCode
./mind setup cursor        # Auto-configure Cursor
./mind setup codex        # Auto-configure Codex
./mind setup windsurf     # Auto-configure Windsurf
./mind setup gemini-cli   # Auto-configure Gemini CLI
./mind setup vscode       # Auto-configure VSCode
./mind setup refresh      # Refresh detected mind-managed integrations
```

`./mind setup` (without an agent) prints an explicit capability matrix for all supported adapters plus non-wired declarations. It now prints full per-level status/confidence/evidence/fallback diagnostics for each listed adapter. OpenClaw is intentionally marked **experimental** (unverified/unsupported, no setup wiring). Cursor remains L2 `unverified` and now has implemented L3 global hooks automation; Codex now reports implemented L2 managed instruction injection while L3 remains unsupported. VSCode is now a supported agent with platform-specific MCP config path. `./mind setup refresh` refreshes only detected mind-managed integrations by default; use `--dry-run`, `--all`, or `--agent <agent>` to control the refresh.

### 4.6 Running tests

```bash
# Unit tests
bun test test/ web/test

# Web-only tests
bun test web/test

# RAG E2E integration test (requires OPENAI_API_KEY, makes real API calls)
make test-rag
# or directly:
OPENAI_API_KEY=sk-... ./scripts/test-rag.sh

# Maintainer release flows
make release-patch
make release-minor
make release-major
make release-simulate TYPE=patch
./scripts/release.sh minor --notes-file docs/release-notes/v1.5.0.md
```

### 4.7 Migrating from legacy brain.json

```bash
./mind import
```

Reads `data/brain.json` (or `$MIND_DATA_DIR/brain.json`) and imports all spaces and memories into SQLite at tier 2.

### 4.8 CLI commands

| Intent              | Command               | Aliases                                     | Params                         | Flags                                                                 | Description                                                                                                                                                       |
| ------------------- | --------------------- | ------------------------------------------- | ------------------------------ | --------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- | --- | ---- | ------ | --- | --------------------- | --------- | ---------------------------------------- |
| Help                | `help`                | `h`                                         | —                              | —                                                                     | List all commands.                                                                                                                                                |
| Create space        | `create`              | `c`                                         | `<space>` `<description>`      | `--tags`                                                              | Create a new space (comma-sep tags).                                                                                                                              |
| List spaces         | `list`                | `ls`, `l`                                   | —                              | `--tag`, `--hidden`                                                   | List all visible spaces by default (optionally include hidden).                                                                                                   |
| List memories       | `list`                | `ls`, `l`                                   | `<space>`                      | `--tier`, `--tag`                                                     | List T1+T2 memories in a space (use `--tier 3` for cold).                                                                                                         |
| Delete space        | `delete`              | `d`                                         | `<space>`                      | —                                                                     | Delete a space and all its memories.                                                                                                                              |
| Rename space        | `rename`              | `rn`                                        | `<old>` `<new>`                | —                                                                     | Rename a space.                                                                                                                                                   |
| Describe space      | `describe`            | `ds`                                        | `<space>` `<description>`      | —                                                                     | Change a space's description.                                                                                                                                     |
| Update space        | `update`              | —                                           | `<space>`                      | `--description`, `--hidden`, `--no-hidden`                            | Update space description and/or visibility.                                                                                                                       |
| Tag space           | `tag`                 | `t`                                         | `<space>` `<tag>`              | —                                                                     | Add a tag to a space.                                                                                                                                             |
| Untag space         | `untag`               | —                                           | `<space>` `<tag>`              | —                                                                     | Remove a tag from a space.                                                                                                                                        |
| Add memory          | `add`                 | `a`                                         | `<space>` `<name>` `<content>` | `--tags`, `--tier`                                                    | Add a memory.                                                                                                                                                     |
| Read memory         | `read`                | `r`                                         | `<space>` `<name>`             | —                                                                     | Print a memory (bumps access + auto-promote).                                                                                                                     |
| Edit memory         | `edit`                | `e`                                         | `<space>` `<name>` `<content>` | —                                                                     | Update a memory's content.                                                                                                                                        |
| Remove memory       | `remove`              | `rm`                                        | `<space>` `<name>`             | —                                                                     | Remove a memory by name.                                                                                                                                          |
| Tag memory          | `tag`                 | `t`                                         | `<space>` `<name>` `<tag>`     | —                                                                     | Add a tag to a memory.                                                                                                                                            |
| Untag memory        | `untag`               | —                                           | `<space>` `<name>` `<tag>`     | —                                                                     | Remove a tag from a memory.                                                                                                                                       |
| Promote             | `promote`             | `up`                                        | `<space>` `<name>`             | —                                                                     | Move memory one tier up (T3→T2, T2→T1).                                                                                                                           |
| Demote              | `demote`              | `down`                                      | `<space>` `<name>`             | —                                                                     | Move memory one tier down (T1→T2, T2→T3).                                                                                                                         |
| Pin                 | `pin`                 | —                                           | `<space>` `<name>`             | —                                                                     | Pin a memory (immune to auto-promotion).                                                                                                                          |
| Unpin               | `unpin`               | —                                           | `<space>` `<name>`             | —                                                                     | Unpin a memory.                                                                                                                                                   |     | Link | `link` | —   | `<source>` `<target>` | `--label` | Link two memories (`space/name` format). |
| Unlink              | `unlink`              | —                                           | `<source>` `<target>`          | —                                                                     | Remove a link between memories.                                                                                                                                   |
| Show links          | `links`               | —                                           | `<space>` `<name>`             | —                                                                     | Show all links for a memory.                                                                                                                                      |
| Search              | `search`              | `s`                                         | `<query>`                      | `--space`, `--tag`, `--tier`, `--detail`                              | Full-text search across memories. Default output includes memory ref, tier, and changed timestamp. `--detail` adds content preview. Use `term*` for prefix match. |
| Query               | `query`               | `q`                                         | —                              | `--space`, `--tag`, `--tier`, `--from`, `--to`, `--limit`, `--offset` | Query memories by metadata/date with pagination (ordered by latest semantic memory changes).                                                                      |
| Status (global)     | `status`              | —                                           | —                              | —                                                                     | Show storage info and per-tier breakdown.                                                                                                                         |
| Status (space)      | `status`              | —                                           | `<space>`                      | —                                                                     | Show tier breakdown for a specific space.                                                                                                                         |
| List tags           | `tags`                | `tgs`                                       | —                              | `--spaces`, `--memories`                                              | List all tags in the system (defaults to both).                                                                                                                   |
| Checkpoint set      | `checkpoint set`      | `cp set`                                    | `<space>` `<goal>` `<pending>` | `--notes`, `--linked-memories`                                        | Create or update an active checkpoint in the project space.                                                                                                       |
| Checkpoint complete | `checkpoint complete` | `cp complete`, `checkpoint done`, `cp done` | `<space>` `<name>` `<what>`    | —                                                                     | Complete a checkpoint and transform it into a same-space `session-*` T3 summary in `projects/<repo>`. The checkpoint is deleted after the summary is created.     |
| Checkpoint recover  | `checkpoint recover`  | `cp recover`                                | `<space>`                      | `--name`                                                              | Recover checkpoint by name (use `checkpoint list` first to find available checkpoints; output is JSON).                                                           |
| Checkpoint list     | `checkpoint list`     | `cp list`                                   | `<space>`                      | `--status`                                                            | List checkpoints from the project space (filtered by `checkpoint` tag).                                                                                           |
| Session migration   | `migrate sessions`    | —                                           | `<space>`                      | `--dry-run`                                                           | Explicitly migrate legacy `sessions/<repo>` summaries into `projects/<repo>` with deterministic naming and preserved links.                                       |
| Guide               | `guide`               | `g`                                         | —                              | —                                                                     | Show usage guide (human mode).                                                                                                                                    |
| Guide (mode)        | `guide`               | `g`                                         | `<mode>`                       | —                                                                     | Show guide (`agent` or `human`).                                                                                                                                  |
| Import              | `import`              | —                                           | —                              | —                                                                     | Import legacy `brain.json` into SQLite.                                                                                                                           |
| Setup refresh       | `setup refresh`       | `install refresh`                           | —                              | `--dry-run`, `--all`, `--agent`                                       | Refresh detected mind-managed agent integrations without bulk-creating unrelated configs.                                                                         |
| Update              | `update`              | —                                           | —                              | `--check`, `--version`, `--repo`, `--no-refresh-integrations`         | Update mind from GitHub releases, then refresh detected integrations unless opted out.                                                                            |
| Sync init           | `sync init`           | —                                           | —                              | —                                                                     | Initialize `.mind/` directory with config.yml and .gitignore.                                                                                                     |
| Sync status         | `sync status`         | `sync ls`                                   | —                              | `--space`                                                             | Show sync status for spaces.                                                                                                                                      |
| Sync enable         | `sync enable`         | —                                           | —                              | `--space`                                                             | Enable autosync for a project space.                                                                                                                              |
| Sync disable        | `sync disable`        | —                                           | —                              | `--space`                                                             | Disable autosync for a space.                                                                                                                                     |
| Sync now            | `sync now`            | —                                           | —                              | `--space`                                                             | Force immediate sync (export + import).                                                                                                                           |
| Sync export         | `sync export`         | —                                           | —                              | `--space`                                                             | Export space memories to markdown files.                                                                                                                          |
| Sync import         | `sync import`         | —                                           | —                              | `--space`                                                             | Import markdown files into a space.                                                                                                                               |
| Sync conflict       | `sync conflict`       | —                                           | —                              | `--space`, `--strategy`                                               | Configure conflict resolution strategy.                                                                                                                           |
| Sync remove         | `sync remove`         | —                                           | —                              | `--space`                                                             | Remove space from sync config.                                                                                                                                    |
| Sync config         | `sync config`         | —                                           | —                              | —                                                                     | Show config file contents.                                                                                                                                        |
| Sync serve          | `sync serve`          | —                                           | —                              | `--space`                                                             | Start file watcher for a space (foreground).                                                                                                                      |

> **Note:** `tag` and `untag` are disambiguated by argument count: 2 positional args = space tag, 3 positional args = memory tag.

### 4.9 MCP Tools

The MCP server exposes 18 tools for agent integration:

#### Spaces (5 tools)

| Tool           | Description                                                                                                                            |
| -------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `space_create` | Create a new space (requires `tags`)                                                                                                   |
| `space_list`   | List all spaces                                                                                                                        |
| `space_get`    | Get a space by name; returns an orientation summary with overview counts, changed-at trending memories by tier, and active checkpoints |
| `space_update` | Update a space description                                                                                                             |
| `space_delete` | Delete a space and all its memories                                                                                                    |

#### Memories (4 tools)

| Tool            | Description                                                                                                                        |
| --------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `memory_add`    | Add a memory to a space (requires `tags`); `links_to` is best-effort and returns `links_created` and `links_failed` arrays         |
| `memory_read`   | Read + record access (auto-promote); returns links_to, linked_by, tier_change. Use noPromote:true to inspect without side effects. |
| `memory_update` | Update a memory name/content by space and name                                                                                     |
| `memory_delete` | Delete a memory by space/name                                                                                                      |

#### Query (1 tool)

| Tool           | Description                                                                                        |
| -------------- | -------------------------------------------------------------------------------------------------- |
| `memory_query` | Unified memory listing (use `search` parameter for full-text search; `tier: null` means all tiers) |

#### Links (2 tools)

| Tool          | Description                                    |
| ------------- | ---------------------------------------------- |
| `link_create` | Create a directional link between two memories |
| `link_delete` | Delete a directional link                      |

#### Checkpoint (4 tools)

| Tool               | Description                                                                                                         |
| ------------------ | ------------------------------------------------------------------------------------------------------------------- |
| `checkpoint_save`  | Create or update a checkpoint (goal, pending, notes, linked_memories).                                              |
| `checkpoint_load`  | Restore a specific checkpoint by name. Returns full checkpoint text plus all linked_memories in memory_read format. |
| `checkpoint_query` | Query checkpoints with filters: status, date range, tag, limit/offset, plus explicit soft-error reporting.          |
| `checkpoint_done`  | Transform checkpoint to a same-space `session-*` T3 summary memory in `projects/<repo>` and delete the checkpoint   |

#### System (2 tools)

| Tool                  | Description                                         |
| --------------------- | --------------------------------------------------- |
| `status`              | Get storage status                                  |
| `system_instructions` | Returns the complete mind usage protocol for agents |

For stage 1 MCP content rendering, all structured tools above except `system_instructions` emit a single raw YAML text item that is semantically identical to `structuredContent`. Content-only tools (`space_delete`, `memory_delete`, `link_create`, `link_delete`) remain unchanged.

### 4.10 Mind Memory Protocol

When using mind via MCP, follow these conventions:

**Tags with prefixes:**

- `type:project` — project space
- `type:user` — user preferences
- `type:config` — global configuration
- `type:learning` — learned knowledge
- `type:session` — session summaries
- `cat:decision` — architectural decision
- `cat:bugfix` — bug fix
- `cat:pattern` — established pattern
- `cat:discovery` — technical discovery
- `cat:preference` — user preference
- `cat:config` — configuration
- `status:*` — convention-only lifecycle tags, such as `status:proposed`, `status:validated`, `status:failed`, `status:superseded`, `status:obsolete`, `status:final`, and `status:living`
- `type:reference` + exactly one `ref:*` + `status:living` — living reference memory tags

**Space hierarchy (use repo name):**

> For software projects, use the repository/directory name as the space name (e.g., `projects/mind`, `projects/arcana-web`). This makes memories discoverable by future agents.

- `projects/<name>` — one space per project
- same-space session summaries live inside `projects/<name>` as `session-*` memories tagged `type:session` + `cat:summary` at T3
- `user/preferences` — global user preferences
- `user/patterns` — user patterns
- `global/config` — cross-project config

**Tier usage:**

- T1 (hot) — critical active info
- T2 (warm) — default for new memories
- T3 (cold) — unlimited

**Memory quality guidance:**

- Checkpoints are live/ephemeral work state.
- Session summaries are chronological recovery logs and evidence, not canonical truth.
- Durable/canonical memories are atomic actionable knowledge for future sessions.
- Living reference memories are maintained current-truth maps for project, architecture, style, domain, or workflow context.
- Create durable memories for stable decisions, verified root causes, final fixes, reusable patterns, user preferences, and significant config/domain facts.
- Avoid durable memories for transient observations, routine progress, or routine validation results with no new findings.

**Living reference convention:** use T2 by default, allow natural promotion to T1, and pin only 1–3 critical references when explicitly warranted or approved. Tags are authoritative: use `type:reference`, exactly one `ref:*` category tag, and `status:living`. Recommended refs are `ref:project-map`, `ref:architecture`, `ref:style`, `ref:domain`, and `ref:workflow`; the memory name is a readable stable kebab-case identifier such as `architecture-overview`, `project-map`, `style-guide`, `domain-model`, or `workflow-notes`. Include Purpose, Current truth, Key areas/files/concepts, Active conventions, Source memories, Last reviewed, and Maintenance notes. Update living references with `memory_update` when current truth changes.

**Deletion guidance:** delete only memories that are clearly obsolete, no longer applicable, and have no historical value. Otherwise, mark `status:obsolete` or `status:superseded` and link the replacement.

**Continuity rule:** link directly relevant memories for recovery continuity. `memory_add` with `links_to` is best-effort — check `links_failed` in the response.

### 4.11 Autosync (Experimental)

Mind can synchronize project spaces with `.md` files on the filesystem. The config is stored in `.mind/config.yml` and is versioned with git. Enabled spaces export automatically after successful CLI, API/web, or MCP DB mutations; export failures and conflicts are logged without reverting the primary DB operation.

**Initialize sync:**

```bash
mind sync init
```

**Enable a space:**

```bash
mind sync enable --space projects/mind
```

**Directory structure:**

```
.mind/
├── config.yml           # spaces config (VERSIONADO)
├── .gitignore
└── spaces/
    ├── a1b2c3d4/        # hash of "projects/mind"
    │   ├── manifest.json
    │   └── memory-1.md
    └── ...
```

**Commands:**
| Command | Description |
|---------|-------------|
| `mind sync init` | Initialize .mind/ directory |
| `mind sync status` | Show configured spaces and drift summary |
| `mind sync enable --space <name>` | Enable sync for a space |
| `mind sync disable --space <name>` | Disable sync |
| `mind sync now --space <name>` | Immediate sync |
| `mind sync export --space <name>` | Export to files |
| `mind sync import --space <name>` | Import from files |
| `mind sync conflict --space <name> --strategy <strategy>` | Set conflict strategy |
| `mind sync remove --space <name>` | Remove from sync |
| `mind sync config` | Show config |
| `mind sync serve --space <name>` | Start file watcher |

**Conflict resolution strategies:**

- `db-wins` — DB version wins on real conflicts; only manifest-managed stale files are pruned.
- `file-wins` — file version wins on real conflicts; automatic DB→FS export skips conflicting files and logs a warning.
- `latest-wins` — hashes detect dirty sides first, then normalized UTC timestamps choose a winner. Near-future timestamps within 5 minutes are accepted for clock skew; farther future or invalid timestamps produce conservative warnings/skips.

**Manifest v2 and conflicts:** manifest entries track memory name, managed path, optional DB ID, canonical content and metadata hashes, normalized UTC timestamps, last file mtime, and last sync time. Hashes decide dirty state against the common baseline; file existence alone is not a conflict. Timestamps are for audit, ordering, and `latest-wins` tie-breaking only. `mind sync status --space <name>` reports DB/file/manifest counts, dirty DB and file counts, conflicts, tombstones, missing managed files, and the latest auto-export warning or error when available.

**MCP integration:** When MCP server starts, it auto-starts watchers for all enabled spaces.

**config.yml format:**

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

**Limitations:**

- File deletion does not auto-delete from DB during watcher imports; missing managed files are reported as warning/drift by `sync status` without modifying the DB.
- Existing-memory imports update supported metadata when file-to-DB wins: content, tags, tier, pinned state, and best-effort `links_to`. Frontmatter names do not rename existing memories in this phase.

---

## 5. Keeping this document updated

**If you modify this repo, keep AGENTS.md in sync with the code.**

**Changelog policy (mandatory):**

- Every non-trivial change (features, behavior changes, architecture changes, bug fixes) must be added to `CHANGELOG.md` under `## [Unreleased]`.
- Release commands (`make release-patch`, `make release-minor`, `make release-major`) require unreleased changelog entries and promote `Unreleased` to a versioned section.
- Use `./scripts/release.sh <patch|minor|major> --notes-file <path>` for curated GitHub release notes; omit `--notes-file` to use GitHub generated notes.
- `make release-simulate TYPE=patch|minor|major` must show what would happen without modifying files/tags/releases.

- **Changes to the `mind` script or completion:** Update [§ 1](#1-project-overview), [§ 2.1](#21-high-level-flow), [§ 2.2](#22-main-modules-and-responsibilities), and [§ 4.2](#42-running-the-cli).
- **Changes to the web app or Docker:** Update [§ 1](#1-project-overview), [§ 2.2](#22-main-modules-and-responsibilities), [§ 3](#3-technical-considerations), and [§ 4.3](#43-web-app).
- **New or removed commands:** Update [§ 4.6 Commands](#46-cli-commands) and, if the architecture changes, [§ 2.1](#21-high-level-flow) / [§ 2.2](#22-main-modules-and-responsibilities).
- **New modules or major refactors:** Update [§ 2.2 Main modules](#22-main-modules-and-responsibilities) and [§ 2.1](#21-high-level-flow).
- **Config or storage changes:** Update [§ 2.3 Data model](#23-data-model), [§ 3](#3-technical-considerations), and [§ 4](#4-usage).
- **New dependencies or runtime requirements:** Update [§ 1](#1-project-overview) and [§ 3](#3-technical-considerations).
- **New or removed test utilities:** Update [§ 3](#3-technical-considerations) (Testing).
- **Schema changes:** Update [§ 2.4 SQLite schema tables](#24-sqlite-schema-tables).

After editing AGENTS.md, re-read the sections you changed to ensure they stay accurate and consistent with the rest of the document.

Before marking work done, use this checklist:

- [ ] Updated `AGENTS.md` if architecture/commands/config changed
- [ ] Updated `CHANGELOG.md` under `## [Unreleased]` for significant changes
- [ ] Updated `README.md` if user-facing behavior/install/update/release flow changed
