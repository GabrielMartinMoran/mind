# Mind Memory Protocol ({{protocolLabel}})

{{#if useWhenConnected}}Use this protocol when {{connectedAgentLabel}} is connected to the `mind` MCP server.{{/if}}{{#if useBeforeToolsWording}}Use this protocol whenever the `mind` MCP server is available.{{/if}}

## Required First Actions

1. `checkpoint_query` — find available checkpoints for the current project space
2. `checkpoint_load { checkpointName: "<name>" }` — recover a specific checkpoint by name
3. `space_get` — check if the project space exists (use repo/directory name: `projects/<repo-name>`)
4. If space doesn't exist: `space_create` with `tags: ["type:project"]`
5. `memory_query { space: "<project>", search: "<current-task-keywords>" }` — find related context

{{#if useBeforeToolsWording}}If this is your first time using mind tools in this session, call `system_instructions` to get the full usage protocol.{{/if}}{{#if useCallBeforeSessionWording}}Call `system_instructions` before using memory tools in a new session for full usage details.{{/if}}

## Memory Types

- Checkpoint = live/ephemeral work state. Keep goal, pending work, and current
  blockers here; update it after subtasks and before risky changes.
- Session summary = chronological log/recovery record created from a completed
  checkpoint. It preserves what happened, but it is evidence, not canonical
  truth.
- Durable/canonical memory = atomic actionable knowledge for future sessions.
- Living reference memory = maintained current truth map for a project, domain,
  architecture, style, or workflow.

| Need                                                                          | Use                                                | Result                               |
| ----------------------------------------------------------------------------- | -------------------------------------------------- | ------------------------------------ |
| Live goal, pending work, blockers, or next action                             | `checkpoint_save`                                  | Active checkpoint                    |
| End-of-session recovery log                                                   | `checkpoint_done`                                  | Same-space `session-*` summary at T3 |
| Stable decisions, root causes, patterns, preferences, config, or domain facts | `memory_add` / `memory_update`                     | Durable memory                       |
| Compact current truth map                                                     | `memory_add` / `memory_update` with reference tags | Living reference                     |
| Obsolete knowledge with no historical value                                   | `memory_delete`                                    | Removed memory                       |

## During Work

### Durable memory threshold

Create or update durable memories when the information is likely useful in
future sessions: stable decisions, verified root causes, final fixes, reusable
patterns, user preferences, or significant config/domain facts. Keep transient
observations, routine progress, and routine validation results with no new findings
in checkpoints or session summaries.

Durable memories are separate from session summaries. Use durable memories when
future sessions need stable decisions, root causes, patterns, preferences,
config, or domain facts.

Use `memory_add` for new durable knowledge:

```
memory_add {
  space: "projects/<repo-name>",
  name: "<descriptive-kebab-name>",
  content: "**What**: ...\n**Why**: ...\n**Where**: ...\n**Learned**: ...",
  tags: ["cat:decision"],
  links_to: ["<space:name of related memory>"]
}
```

- Every memory MUST have at least 1 tag: `cat:decision`, `cat:bugfix`, `cat:discovery`, `cat:pattern`, `cat:preference`, `cat:config`
- Always check for related memories with `memory_query { space: "<project>", search: "<keywords>" }` and pass their names to `links_to`
- When a new memory depends on, updates, or explains another memory, pass related memories in `links_to`.
- After adding with `links_to`, check `links_created` and `links_failed`; retry important failed links with `link_create`.
- Update checkpoint after completing subtasks: `checkpoint_save`

Persist verified root causes, regressions, risk decisions, or durable validation
patterns. Don't persist routine validation outcomes unless they change future
work.

### Before creating a durable memory

Confirm it meets this threshold:

- **Future utility**: Will a future session need this?
- **Novelty**: Is this new knowledge (not already captured)?
- **Evidence**: Is it verified (not speculation)?
- **Stability**: Is it settled (not likely to change soon)?

If any answer is NO, keep it in the checkpoint or session summary instead.

### Status tags

`status:*` tags are convention-only, not schema-enforced. Use well-normed tags
such as `status:proposed`, `status:validated`, `status:failed`,
`status:superseded`, `status:obsolete`, `status:final`, and `status:living`.

### Living reference memories

Use living references for compact current truth. Create them at T2 by default;
let reads naturally promote them to T1. Pin only 1–3 critical references when
explicitly warranted or approved.

Tags are authoritative. Required tags: `type:reference`, exactly one `ref:*`, and `status:living`.
Recommended refs: `ref:project-map`, `ref:architecture`, `ref:style`,
`ref:domain`, `ref:workflow`. The `ref:*` tag defines the reference category; the memory name is the readable identifier.

Recommended names: `architecture-overview`, `project-map`, `style-guide`, `domain-model`, and `workflow-notes`.

Recommended sections: Purpose, Current truth, Key areas/files/concepts, Active
conventions, Source memories, Last reviewed, Maintenance notes.

When current truth changes, use `memory_update` on the living reference and
link it to source memories. Sessions remain evidence/logs, not canonical truth.

### Living reference taxonomy and maintenance

**7 reference types** (required tags: `type:reference` + one `ref:*` + `status:living`):

| ref tag              | Recommended name        | Purpose                                      |
| -------------------- | ----------------------- | -------------------------------------------- |
| `ref:project-map`    | `project-map`           | Entry points, key modules, repo layout       |
| `ref:architecture`   | `architecture-overview` | Stack, layers, data flow, boundaries         |
| `ref:domain`         | `domain-model`          | Core entities, business rules, vocabulary    |
| `ref:workflow`       | `workflow-notes`        | CI/CD, release process, testing conventions  |
| `ref:style`          | `style-guide`           | Code conventions, naming, formatting         |
| `ref:key-decisions`  | `key-decisions`         | Cross-cutting architectural decisions        |
| `ref:known-pitfalls` | `known-pitfalls`        | Recurring gotchas and anti-patterns to avoid |

**Creation triggers** — create a living reference when:

- A project space is created → create `project-map` immediately.
- 3+ durable memories reference the same subsystem → create or update `architecture-overview`.
- A decision affects 2+ modules → add it to `key-decisions`.
- A debugging step or workaround repeats → add it to `known-pitfalls`.

**Update triggers** — update a living reference when:

- A decision is changed or superseded → update `key-decisions`.
- A new module, convention, or workflow is added → update the relevant reference.
- A pitfall stops applying → mark it resolved in `known-pitfalls`.
- After a major refactor or release → review all living references.

**Living reference content format:**

- Purpose — why this reference exists.
- Current truth — what is true now; this is the canonical part.
- Key areas/files/concepts — what an agent needs to know.
- Active conventions — rules currently in force.
- Source memories — links to durable memories this summarizes.
- Last reviewed — date in YYYY-MM-DD format.
- Maintenance notes — how to keep this updated.

**Living reference vs durable memory:** durable memories capture events (decisions, fixes, discoveries); living references capture state (the current truth map). When truth changes, update the living reference and link new durable memories as sources.

**Anti-staleness:** Review every living reference at least every 30 days. If unchanged, update `Last reviewed`. If truth changed, update `Current truth` and link new source memories.

**Granularity minimum:** Every project space should have at least a `ref:project-map`. Create higher-level references only when they serve future sessions.

### Cautious deletion

Use `memory_delete` only when a memory is clearly obsolete, no longer
applicable, and has no historical value. Otherwise, mark it with
`status:obsolete` or `status:superseded` and link the replacement.

### Searching effectively

`memory_query { space: "<project>", search: "..." }` ranks results with the
same fused pipeline used by the CLI and API. Each result carries a `confidence`
bucket (`high`, `medium`, `low`) and a `methods` list naming the channels that
matched it.

Query grammar:

- `"quoted text"` matches a phrase.
- `OR` unions alternatives (`auth OR login`); adjacent terms are ANDed.
- `AND` is the explicit form of the implicit AND.
- `NOT` excludes the following term (`auth NOT jwt`).
- A trailing `*` matches a prefix (`type*`).
- Malformed operator usage degrades to a safe literal match and never errors.

Multi-word queries relax automatically: exact phrase and all-term matches rank
first, then near matches, substrings, and close spellings. Read `confidence`
and `methods` to judge each result:

- `high` — a strong exact or all-term match; trust it.
- `medium` — a relaxed, substring, or semantic match; verify if it matters.
- `low` — a weak or fuzzy single-channel match; treat it as a lead.

When results are empty or mostly `low`:

1. Simplify to the most distinctive term and drop operators.
2. Broaden with `OR`, or shorten to a prefix (`conf*`).
3. Drop filters (`tag`, `tier`, `from`, `to`) or search every space with
   `space: "*"`.
4. If search still misses, explore the repo directly, then add or link
   memories so the knowledge is recoverable next time.

## Session End

1. Checkpoints hold live state; `checkpoint_done` completes the active checkpoint and creates a same-space `session-*` summary memory in `projects/<repo-name>` with `type:session` + `cat:summary` at T3.
2. (optional) `memory_update` to enrich the session memory if needed

## Checkpoint Aging

If the active checkpoint is **less than 30 minutes old**: continue using it.
If it is **30 minutes or older**: close it with `checkpoint_done` and create a new one with `checkpoint_save`.

## Post-Compaction Recovery

If context resets or compaction happens:

1. `checkpoint_query` to find available checkpoints
2. `checkpoint_load { checkpointName: "<name>" }` to restore a specific checkpoint
3. `memory_query { space: "<project>", search: "<keywords>" }` for recent context
4. Re-establish goal, pending steps, and relevant files before making edits

## Quick Checklist

- Start with `checkpoint_query`, `checkpoint_load`, `space_get`, and task-focused `memory_query`
- Save live progress with `checkpoint_save`
- Add tagged durable memories for stable knowledge that future sessions need
- Link related memories with `links_to` or `link_create`
- Close active work with `checkpoint_done`
