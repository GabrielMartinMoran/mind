# CLI, web UI, and MCP reference

This reference keeps operational examples and detailed MCP response behavior
out of the [project README](../README.md). For how retrieval works internally, see
[Search engine](search-engine.md); for browser architecture, see [Web UI](web-ui.md).

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
mind migrate sessions projects/<repo> --dry-run
mind checkpoint list <space> --status active
mind search "query"
mind query --space <space> --from 2026-01-01 --to 2026-12-31 --limit 20 --offset 0
mind update --check
mind update
```

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
- returns minimal payload per node: `id:string`, `name`, `tier`, `links_to:string[]`, `linked_by:string[]`
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

`memory_query` supports optional `search` for full-text search and returns pagination fields such as `total`, `limit`, and `offset` in both `structuredContent` and YAML content. Search results always include `confidence`. The diagnostic fields `score`, `methods`, and the top-level `search_method` appear only when the Mind MCP process sets `USE_DEBUGGING_EXPANDED_TOOLS_RESPONSE=true`; the flag is Mind's, not a client setting. Its optional `tier` field also accepts `null`, which means the same thing as omitting the tier filter (all tiers).

Memory MCP workflows also support bounded composite ergonomics while keeping atomic tools:

- `memory_add` supports optional `pinned` and `links_to` (best-effort — check `links_failed` in response).
- `memory_read` returns directional linked summaries via `links_to` and `linked_by` with each relation's `label` and `direction` (`outgoing`/`incoming`). Use `noPromote:true` to inspect without promotion.
- `memory_update` updates `newName`/`content`/`tags`, sets `pinned`, and moves one tier with `tierTransition` (`promote`/`demote`). `tags` replaces the existing set.
- `link_create` is directional (`sourceRef` → `targetRef`) with a label; re-creating the same directed pair replaces the label. `link_delete` is a no-op when the link is absent.
- Memory MCP payloads use `changed_at` and do not expose `access_count`,
  `last_accessed_at`, `created_at`, or `updated_at`.

`space_get` now returns an orientation summary for one space:

- `overview` with total memory count, active checkpoint count, and per-tier
  counts
- `trending_memories` grouped into `tier_1`, `tier_2`, and `tier_3`, ranked by
  `changed_at`, with a bounded T3 preview plus total availability
- per-tier `coverage` metadata so agents can tell whether each preview is
  complete or only a subset
- a `references` block of living references (`type:reference` + `status:living`)
- plural `active_checkpoints` with checkpoint items matching `checkpoint_query`

Checkpoint MCP tools are also available for session continuity:

- `checkpoint_save`
- `checkpoint_done`
- `checkpoint_load`
- `checkpoint_query`

`checkpoint_done` now closes a live checkpoint into a same-space `session-*` summary memory in `projects/<repo>` with tags `type:session` + `cat:summary` at T3. Legacy `sessions/<repo>` content can be explicitly migrated with `mind migrate sessions <project-space> [--dry-run]`.

`checkpoint_load` requires `checkpointName` (use `checkpoint_query` first to find available checkpoints). It returns full checkpoint text fields plus all linked_memories in enriched format, and checkpoint MCP payloads use `changed_at` instead of `created_at` / `updated_at`.

`checkpoint_query` returns full pending text (no preview truncation) and includes an explicit `error` field (`null` on success, `{ code, message }` when the requested space is missing).

System tools for agent protocol:

- `system_instructions` — returns the complete Mind protocol (six responsibilities and tool examples) as an optional reference
- `status` — get storage status

### Update

mind can update itself from GitHub Releases:

```bash
mind update --check                 # check if a newer release exists
mind update                         # update to latest release
mind update --version v0.1.0        # update to a specific tag
mind update --no-refresh-integrations
```

After a successful update, if a database existed before installation, Mind runs
the newly installed `mind status` first. This forces automatic DB migration,
backup validation, and restore handling before refreshing integrations. Fresh
installs with no existing DB skip this step so `mind update` doesn't create a
database. Mind then refreshes detected mind-managed integrations by default so
protocols, MCP configs, hooks, plugins, scripts, skills, and managed cleanup stay
current. Use `--no-refresh-integrations` to skip the integration refresh.
