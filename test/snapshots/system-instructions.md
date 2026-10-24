# Mind Memory Protocol (fallback)

This is the complete fallback copy for the `mind` MCP server, used only when the `mind-management` skill is not listed or cannot be loaded. The skill is the primary source of truth. If the skill is available, load it unconditionally before any Mind use; otherwise follow this text.

<!-- mind-cognitive-protocol:body -->

## How to use this protocol

Mind keeps knowledge across sessions. The six responsibilities below are
criteria for choosing the right action, not a fixed sequence. Use the ones the
current task needs.

- Keep project knowledge in `projects/<repo>`, using the actual repository name.
- Every memory needs at least one tag.
- Create a space with `space_create` before adding memories to it.

## ORIENT

**Trigger:** A session starts, the task changes, or context was compacted.

Check the project space and any active checkpoint before doing work. `space_get`
returns overview counts, T1/T2/T3 previews, living references, active
checkpoints, and T3 availability without loading the whole tier.

```json tool:checkpoint_query
{ "space": "projects/mind", "status": "active" }
```

```json tool:space_get
{ "name": "projects/mind" }
```

If the space is missing, call `space_create` with `tags: ["type:project"]`.
Use `checkpoint_query { space: "projects/mind" }` to list active checkpoints.
To restore one, call
`checkpoint_load { space: "projects/mind", checkpointName: "<name>" }`.

If there is no active checkpoint, look for recent session summaries
(`type:session` + `cat:summary`) in the project space and orient from them. Do
not create an artificial checkpoint just to satisfy the ritual.

## RECALL

**Trigger:** You need a decision, root cause, convention, or prior context.

Start with a natural, focused question. One query is usually enough; refine only
when the results are weak or ambiguous.

```json tool:memory_query
{
  "space": "projects/mind",
  "search": "Why did we choose JWT for authentication?",
  "limit": 10
}
```

For explicit constraints, use structured syntax as an additional tool.
`memory_query` supports quoted phrases, `OR`, `AND`, `NOT`, and a trailing `*`
prefix.

```json tool:memory_query
{
  "space": "projects/mind",
  "search": "jwt NOT legacy",
  "limit": 10
}
```

Results include `confidence` (`high`, `medium`, `low`) and `methods`.
Use `space: "*"` to search across spaces. `memory_query` does not record access
or promote tiers.

Read selected memories with `memory_read`. Active use promotes one tier
(T3 to T2 to T1). For inspection only, pass `noPromote: true`:

```json tool:memory_read
{ "space": "projects/mind", "name": "auth-token-rotation", "noPromote": true }
```

RAG is optional and off by default. When enabled, semantic matches can appear
without sharing words with the query; check `methods` before trusting a weak
hit.

### Temporal fallback

When the user asks what they have been working on recently, or continuity
remains unclear after checking useful checkpoints and session summaries, use
`memory_query` without a `search` field to inspect recently changed memories in
the relevant project space. Use `space: "*"` for an explicitly cross-project
recap. Start with a small `limit`; prioritize session summaries and memories
about decisions, discoveries, or fixes, then inspect only promising candidates
with `memory_read` and `noPromote: true`.

Use this only on demand, not as a startup ritual: do not fetch a fixed batch of
recent memories when a checkpoint, session summary, or focused query already
answers the question. `changed_at` is a retrieval clue, not a complete activity
history: it records the latest relevant memory change, can reflect maintenance
changes, and does not preserve intermediate versions or all tag/link changes.
Describe what the retrieved memories support and state when the evidence is
incomplete.

## LEARN

**Trigger:** You verified stable knowledge that future sessions need: a
decision, root cause, fix, discovery, preference, constraint, or current truth.

Check for a related or equivalent memory before creating a new one when
duplication is reasonably possible. Reuse or update the existing memory instead
of adding a near-duplicate.

Add one atomic memory with a name that states the fact, content that explains
what, why, and where, and at least one tag. Include `links_to` when the relation
is known, then check `links_created` and `links_failed`.

### Memory type examples

Architectural decision:

```json tool:memory_add
{
  "space": "projects/mind",
  "name": "semantic-admission-bypass",
  "content": "**What**: Semantic-only results bypass lexical admission at cosine 0.6.\n**Why**: Paraphrases had no lexical overlap.\n**Where**: src/store/repositories/search-repository.ts",
  "tags": ["cat:decision", "status:validated"],
  "links_to": ["search-pipeline"]
}
```

Bug and root cause:

```json tool:memory_add
{
  "space": "projects/mind",
  "name": "fts-trigger-null-contentless",
  "content": "**What**: Contentless trigram FTS cannot use rebuild.\n**Why**: bun:sqlite rejects content= triggers.\n**Where**: src/store/shared/fts-helpers.ts\n**Learned**: Recover with delete-all plus repopulate.",
  "tags": ["cat:bugfix", "search"]
}
```

Discovery:

```json tool:memory_add
{
  "space": "projects/mind",
  "name": "token-set-rescaling-semantic",
  "content": "**What**: Adding semantic rows before token_set changes lexical normalization.\n**Why**: token_set coverage is recomputed over the combined row set.\n**Where**: src/store/repositories/search-repository.ts",
  "tags": ["cat:discovery", "search"]
}
```

Preference or constraint:

```json tool:memory_add
{
  "space": "user/preferences",
  "name": "avoid-fixed-sleeps-in-tests",
  "content": "**What**: Tests must not use fixed sleeps.\n**Why**: Slow and flaky under load.\n**Where**: test/**",
  "tags": ["cat:preference", "testing"]
}
```

Current knowledge as a living reference:

```json tool:memory_add
{
  "space": "projects/mind",
  "name": "architecture-overview",
  "content": "**Purpose**: Current architecture map.\n**Current truth**: CLI, MCP, API, and store share one search pipeline.\n**Source memories**: search-pipeline, semantic-admission-bypass",
  "tags": ["type:reference", "ref:architecture", "status:living"]
}
```

### Supersede a changed decision

Do not overwrite the historical memory. Keep the old record and create a new one
for the current truth.

Create the replacement with the new decision and its `cat:*` tags:

```json tool:memory_add
{
  "space": "projects/mind",
  "name": "revocable-access-tokens",
  "content": "**What**: Short-lived access tokens with server-side revocation replace stateless JWTs.\n**Why**: JWTs could not be revoked quickly.\n**Where**: src/auth/session.ts",
  "tags": ["cat:decision", "auth", "status:validated"]
}
```

Mark the historical memory `status:superseded` by sending its original tags plus
`status:superseded`. `memory_update.tags` replaces the whole set, so re-include
every original tag. Do not send `content`.

```json tool:memory_update
{
  "space": "projects/mind",
  "name": "jwt-over-sessions",
  "tags": ["cat:decision", "auth", "status:superseded"]
}
```

Link the replacement to the historical memory with `contradicts`:

```json tool:link_create
{
  "sourceRef": "projects/mind:revocable-access-tokens",
  "targetRef": "projects/mind:jwt-over-sessions",
  "label": "contradicts"
}
```

Then update the living references that state the old decision.

## RELATE

**Trigger:** Two memories have a meaningful relation.

Add a link only when it helps future work; unnecessary links add noise.

`memory_add.links_to` creates a generic `related` link from the new memory to
each target. Use `link_create` when the relation has a specific label and
direction.

Common labels are `depends_on`, `caused_by`, `extends`, `implements`,
`contradicts`, and `relates_to`. `link_create` is directional: source to
target. Use `space:name` refs, or a bare name to resolve in the source space.
Re-creating the same directed pair replaces its label, so relabel by calling
`link_create` again. `link_delete` removes that direction and succeeds as a no-op when it is absent.
If the direction is wrong, create the correct direction and delete the stale one.
`memory_read` returns each relation's label and direction (`outgoing` or `incoming`).

```json tool:link_create
{
  "sourceRef": "projects/mind:session-revocation",
  "targetRef": "projects/mind:jwt-over-sessions",
  "label": "implements"
}
```

## MAINTAIN

**Trigger:** Knowledge changes, importance changes, or a review finds stale
truth.

Tiers describe use, not quality: T1 is the working set, T2 is nearby context,
and T3 is the archive. T3 is not a ranking penalty; search still finds it.
Inspect a memory with `memory_read` plus `noPromote: true`; use `memory_read`
without it when you intend to use the memory and want normal promotion.
`pinned` protects a memory from automatic promotion and LRU eviction, while an
explicit `tierTransition` still moves it.

```json tool:memory_update
{
  "space": "projects/mind",
  "name": "security-review-checklist",
  "content": "**What**: Review auth, input validation, and secret handling.\n**Why**: Recurring release gate.",
  "tags": ["cat:pattern", "security", "release"],
  "pinned": true,
  "tierTransition": "promote"
}
```

`tags` replaces the existing set. When using `memory_update.tags`, re-include
the tags you want to keep.

### Supersede a changed decision

Create the replacement, mark the historical memory `status:superseded` without
changing its content, link the pair with `contradicts`, then update the affected
living references. The LEARN section shows the exact calls.

### Living references

Living references hold current truth. Required tags are `type:reference`,
exactly one `ref:*` tag, and `status:living`. Use T2 by default, let reads
promote them naturally, and pin only when warranted. Link source memories and
update a reference when truth changes, not on a calendar quota.

| ref tag              | Current truth it maps                |
| -------------------- | ------------------------------------ |
| `ref:project-map`    | Entry points, modules, repo layout   |
| `ref:architecture`   | Stack, layers, data flow, boundaries |
| `ref:domain`         | Entities, business rules, vocabulary |
| `ref:workflow`       | CI/CD, release process, testing      |
| `ref:style`          | Code conventions, naming, formatting |
| `ref:key-decisions`  | Cross-cutting decisions              |
| `ref:known-pitfalls` | Recurring gotchas and anti-patterns  |

Delete a memory only when it is obsolete, no longer applicable, and has no
historical value. Otherwise mark it `status:superseded` or `status:obsolete`
and link the replacement.

## HANDOFF

**Trigger:** A plan is approved, a subtask finishes, a decision or blocker
appears, a risky operation is about to start, or the session ends.

Save a checkpoint at those events. Include the goal, pending work, notes, and
the memories needed to recover:

```json tool:checkpoint_save
{
  "space": "projects/mind",
  "goal": "Replace JWT sessions with revocable tokens",
  "pending": "Update the auth middleware tests",
  "notes": "Decision recorded in session-revocation",
  "linked_memories": ["projects/mind:session-revocation"]
}
```

```json tool:checkpoint_query
{ "space": "projects/mind", "status": "active" }
```

```json tool:checkpoint_load
{ "space": "projects/mind", "checkpointName": "checkpoint-2026-10-19T10-00-00-000Z" }
```

At session end, the checkpoint reflects whether work is still pending. When
pending work remains, update the checkpoint and do **not** call
`checkpoint_done`; the next session can recover the task. When the task is
complete, call `checkpoint_done` to turn the active checkpoint into a
same-space `session-*` summary at T3 with `type:session` and `cat:summary`.
Clear `pending` only when the work is finished or explicitly abandoned, and
record the reason in notes. Provide a meaningful summary of what was done.

```json tool:checkpoint_done
{
  "space": "projects/mind",
  "checkpointName": "checkpoint-2026-10-19T10-00-00-000Z",
  "summary": "**Goal**: Replace JWT sessions. **Done**: Decision and links recorded. **Pending**: none."
}
```

After compaction or a context reset, load the active checkpoint and the
memories it links to, then recall the task keywords before editing files. If no
checkpoint exists, look for recent session summaries; do not perform a closing
ritual or create a placeholder checkpoint.

```json tool:checkpoint_load
{ "space": "projects/mind", "checkpointName": "checkpoint-2026-10-19T10-00-00-000Z" }
```

## Appendix: tools, tags, and anti-patterns

Recommended space tags: `type:project`, `type:user`, `type:session`,
`type:config`, `type:learning`. Recommended memory tags: `cat:decision`,
`cat:bugfix`, `cat:pattern`, `cat:discovery`, `cat:preference`, `cat:config`,
`cat:summary`. `status:*` tags are conventions, such as `status:proposed`,
`status:validated`, `status:failed`, `status:superseded`, `status:obsolete`,
`status:final`, and `status:living`.

Memory content: state **What** happened, **Why** it matters, **Where** it
applies, and **Learned** gotchas when useful.

Anti-patterns:

- Saving every observation: keep transient progress in a checkpoint or session
  summary, and save durable memories for stable knowledge.
- Searching before every write: check for duplication only when it is
  reasonably possible.
- Using `memory_read` just to inspect: pass `noPromote: true`.
- Replacing a decision by deleting history: update current truth, mark the old
  decision `status:superseded`, and link the pair with `contradicts`.
- Demoting memories on a schedule: let use and explicit transitions decide.
