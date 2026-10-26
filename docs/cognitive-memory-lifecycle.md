# Cognitive memory lifecycle

Mind is more than a store you query. It is a cognitive workspace where an agent
turns experience into durable knowledge, keeps that knowledge current, and
recovers it across sessions. This guide explains the model behind that
workspace: how to decide what to remember, how to organize it, and how to
maintain it over time.

The normative, compact instructions live in the canonical protocol at
[`src/resources/protocols/mind-cognitive-protocol.md`](../src/resources/protocols/mind-cognitive-protocol.md).
Agents load those instructions through the complete `mind-management` skill;
see [`docs/skill-first-distribution.md`](skill-first-distribution.md) for the
activation and installation model. This document is the reference and
explanation layer around the protocol. Read the protocol for the exact tool
calls; read this page to understand why the calls are shaped that way. For the
retrieval layer those calls depend on, see the
[search engine](search-engine.md) page.

## Mind as a cognitive workspace

A memory system earns its value only when the right knowledge reaches the
agent at the right moment. Mind models that goal with five principles. They are
habits of judgment, not a sequence to run on every message.

### Remembering is selecting

Not every observation deserves durable storage. Checkpoints and session
summaries capture transient progress. Durable memories capture stable
knowledge that a future session would otherwise have to rediscover: a verified
root cause, a decision and its reasoning, a constraint, a reusable pattern.
Selection is the first act of memory quality.

### Knowing is relating

An isolated fact is harder to trust and harder to find than a fact connected to
its context. Links encode why memories matter to each other: this fix
`caused_by` that bug, this implementation `implements` that decision, the new
decision `contradicts` the old one. Relation is what turns rows into knowledge.

### Maintaining is reorganizing

Knowledge ages. A decision is replaced, a workaround becomes permanent, a
reference drifts from the code. Maintenance means updating current truth,
preserving history, and reconnecting the pieces. It is reorganization, not
accumulation.

### Retrieving is finding meaning

Search should surface a memory even when the query does not reuse its exact
words. Mind combines lexical channels with optional semantic recall, so a
paraphrase can find the fact that answers it. Retrieval is finding meaning, not
matching strings.

### Maintenance is contextual

There is no calendar quota for reviewing memories. You update a living
reference when the truth it maps changes. You promote a memory when its use
pattern changes. You pin something when losing it would be costly. Maintenance
follows context.

## Tiers describe use, not quality

Mind organizes memories into three tiers. The tiers model working-set
distance, similar to a CPU cache. They do not rank truth or importance.

| Tier      | Role               | Typical content                                     |
| --------- | ------------------ | --------------------------------------------------- |
| T1 (hot)  | Active working set | Current task decisions, pinned essentials           |
| T2 (warm) | Nearby context     | Project knowledge and living references             |
| T3 (cold) | Archive            | Session summaries, historical and rarely used facts |

T3 is an archive, not a penalty. Search still finds T3 memories, and reading a
memory promotes it. A fact is not worse because it sits in T3; it is simply
further from the current working set.

### Automatic movement

New memories default to T2. Reading a memory with active use promotes it one
tier (T3 → T2 → T1). When a tier is full, Mind evicts the least-recently-used
non-pinned memory one tier down. T3 is unlimited, so nothing is evicted from
the archive.

### Pinning protects against automation

A pinned memory is immune to automatic promotion and LRU eviction. Pin a memory
when accidental loss would be expensive, such as a release checklist or a
critical constraint. Pinning is a protection against automatic movement, not a
freeze: an explicit `tierTransition` still moves a pinned memory.

Use `memory_update` with `pinned: true` or `pinned: false` to change the flag.
Use `tierTransition: "promote"` or `"demote"` to move exactly one tier. The
update is atomic with any content or tag change in the same call. If a
transition cannot be satisfied, the whole update rolls back.

Reading a memory is an active-use signal and promotes it automatically. When
you only need to inspect a memory, use `memory_read` with `noPromote: true` so
the tier does not change.

## The memory lifecycle

Durable knowledge moves through six responsibilities. The canonical protocol
names them ORIENT, RECALL, LEARN, RELATE, MAINTAIN, and HANDOFF. The lifecycle
below shows how a piece of knowledge travels through them.

### Capture

Start from verified experience. A decision was made, a bug was fixed, a
constraint was discovered, a preference was stated. Check whether an equivalent
memory already exists when duplication is reasonably possible. Reuse or update
it instead of adding a near-duplicate.

### Classify

Choose the artifact that matches the lifetime of the information. The four
artifacts have different jobs and should not be mixed.

| Artifact         | Lifetime      | Purpose                                             |
| ---------------- | ------------- | --------------------------------------------------- |
| Checkpoint       | Hours to days | Live work state: goal, pending work, recovery links |
| Session summary  | Historical    | Chronological record of what a session did          |
| Durable memory   | Long-lived    | Atomic, actionable knowledge for future sessions    |
| Living reference | Maintained    | Current truth map for a project area                |

A checkpoint is ephemeral. A session summary is evidence, not canonical truth.
A durable memory is the unit of reusable knowledge. A living reference is the
maintained index of what is true now.

### Relate

Link the memory to the knowledge it depends on, caused, extends, implements,
or contradicts. Do this while the context is fresh. A link added later is still
useful, but the reasoning is easier to recover when it is recorded at write
time.

### Maintain

Update current truth when it changes. Promote or pin memories whose use pattern
changes. Fix stale links and references. Maintenance is triggered by a real
change, not by a schedule.

### Supersede

When new knowledge replaces old knowledge, do not delete the history. Update
the current truth, mark the old memory as superseded, and link the new memory
to the old one. The historical reasoning stays available while the current
answer stays unambiguous.

### Handoff

Before a session ends, or after a plan or blocker appears, save a checkpoint
with the goal, pending work, notes, and recovery links. When the session ends
with work still pending, update the checkpoint and keep it active; do not
convert it into a session summary. Convert the checkpoint with
`checkpoint_done` only when the task is complete (or explicitly abandoned and
cleared). The next session then orients from the active checkpoint, the
session summaries, or current truth and recovers the task without replaying the
whole conversation.

## Writing high-quality memories

A durable memory is useful when a future agent can find it, trust it, and act
on it without the original conversation. Good memories share a set of
qualities.

- **Atomic.** One memory states one fact or decision. Split unrelated claims.
- **Self-contained.** The memory explains enough context to stand alone.
- **Clear.** The name states the fact; the content uses plain language.
- **Contextual.** State what changed, why it matters, and where it applies.
- **Verifiable.** Prefer facts you confirmed over impressions.
- **Retrievable.** Use the words a future query would use, including the
  domain terms and file or module names.
- **Updatable.** Keep one current-truth memory per topic so it can be revised.
- **Linkable.** Name the related memories so the knowledge is connected.

These are qualities, not a rigid template. The examples below show how the
qualities appear in different kinds of knowledge.

### Architectural decision

State the decision, the reason, and where it applies. Link it to the context
that motivated it.

```text
Name: semantic-admission-bypass
What: Semantic-only results bypass lexical admission at cosine 0.6.
Why: Paraphrased queries had no lexical overlap with the target memory.
Where: src/store/repositories/search-repository.ts
```

Tags: `cat:decision`, `status:validated`. Link to the search pipeline memory.

### Bug and root cause

State the failure, the verified cause, and the fix. A future agent needs the
cause more than the symptom.

```text
Name: contentless-trigram-rebuild-unsupported
What: Contentless trigram FTS cannot use the rebuild command.
Why: The index has no stored content to rebuild from.
Where: src/store/shared/fts-helpers.ts
Learned: Recover with delete-all plus repopulate.
```

Tags: `cat:bugfix`, `search`.

### Discovery

Record a non-obvious technical finding that changes how future work should be
done.

```text
Name: token-set-rescaling-semantic
What: Adding semantic rows before token_set changes lexical normalization.
Why: token_set coverage is recomputed over the combined row set.
Where: src/store/repositories/search-repository.ts
```

Tags: `cat:discovery`, `search`.

### Preference or constraint

Keep user and environment constraints in the appropriate space, with the
reason so they are not mistaken for arbitrary rules.

```text
Name: avoid-fixed-sleeps-in-tests
What: Tests must not use fixed sleeps.
Why: They are slow and flaky under load.
Where: test/**
```

Tags: `cat:preference`, `testing`.

### Living reference

A living reference is a current-truth map. Give it a stable name, the required
reference tags, and links to its source memories.

```text
Name: architecture-overview
Purpose: Current architecture map.
Current truth: CLI, MCP, API, and store share one search pipeline.
Source memories: search-pipeline, semantic-admission-bypass
```

Tags: `type:reference`, `ref:architecture`, `status:living`.

### Replaced decision

Do not overwrite the historical memory. A changed decision produces three
distinct records:

- **Historical memory** — the old decision, with its original content and
  category tag, plus `status:superseded`.
- **Current durable memory** — a new memory with the new decision and its own
  `cat:*` tag.
- **Living reference** — the current-truth map that summarizes the affected
  area and links to its source memories.

```text
Name: jwt-over-sessions
What: Use stateless JWTs for authentication.
Why: Avoid server-side session storage during horizontal scaling.
Where: src/auth/session.ts
```

Tags: `cat:decision`, `auth`, `status:superseded`. The historical content stays
unchanged. The new truth lives in a separate memory, for example:

```text
Name: revocable-access-tokens
What: Use short-lived access tokens with server-side revocation.
Why: Stateless JWTs could not be revoked quickly.
Where: src/auth/session.ts
```

Tags: `cat:decision`, `auth`, `status:validated`.

## Updating and superseding knowledge

`memory_update` applies all requested changes in one atomic operation. The
exact procedure for a changed decision is:

1. Create the replacement memory with the new fact and its `cat:*` tags.
2. Mark the historical memory `status:superseded` by sending its original tags
   plus `status:superseded`. Do not change its content.
3. Link the new memory to the old one with `contradicts`.
4. Review the living references that describe the affected area and update them
   to the new truth.

Two behaviors matter during updates:

- `memory_update.tags` **replaces** the existing tag set. Re-include every tag
  you want to keep, including the original `cat:*` tag when marking a memory
  `status:superseded`. If you omit `tags`, the existing tags are unchanged.
- A transition and a content change in the same call succeed or fail together.
  If the target tier cannot accept the memory, nothing is partially written.

If you cannot complete a supersession in one call, keep the old memory
unchanged until the replacement exists. A gap is safer than a broken link.

## Linking and relinking

Links are directional. A link from source to target means the relation holds in
that direction. The label states what the relation is.

Common labels:

- `depends_on` — the source needs the target to work.
- `caused_by` — the source was caused by the target.
- `extends` — the source builds on the target.
- `implements` — the source implements the target decision or interface.
- `contradicts` — the source replaces or conflicts with the target.
- `relates_to` — a meaningful relation that none of the above describes.

`memory_add.links_to` creates a generic `related` link from the new memory to
each target. Use `link_create` when the relation needs a specific label and
direction. Add links only when they help future work; unnecessary links add
noise.

`link_create` takes a source reference and a target reference. Re-creating the
same directed pair replaces its label, so relabeling is one call, not a delete
plus create. `link_delete` removes that direction and succeeds as a no-op when
the link is absent. If the direction is wrong, create the correct direction and
delete the stale one.

`memory_read` returns direct relations in both directions. Each linked summary
includes its `label` and `direction` (`outgoing` or `incoming`). The result is
bounded to direct relations and metadata, so it is safe to use for
orientation. It does not recursively traverse the graph.

Use a bare name to resolve a target in the source space, or a qualified
`space:name` reference to cross spaces. The CLI `link` and `unlink` commands
parse `space/name` at the first slash, so they cannot link memories in nested
spaces such as `projects/mind`. Use the MCP `link_create` and `link_delete`
tools with qualified references for those cases.

## Living references

Living references answer "what is true now" for an area of the project. They
are maintained maps, not chronological logs. To qualify, a memory needs three
tags:

- `type:reference`
- exactly one `ref:*` category tag
- `status:living`

The seven reference categories are:

| ref tag              | Current truth it maps                    |
| -------------------- | ---------------------------------------- |
| `ref:project-map`    | Entry points, modules, repository layout |
| `ref:architecture`   | Stack, layers, data flow, boundaries     |
| `ref:domain`         | Entities, business rules, vocabulary     |
| `ref:workflow`       | CI/CD, release process, testing          |
| `ref:style`          | Code conventions, naming, formatting     |
| `ref:key-decisions`  | Cross-cutting decisions                  |
| `ref:known-pitfalls` | Recurring gotchas and anti-patterns      |

Use T2 by default. Let reads promote a reference naturally, and pin it only when
losing it would be costly. Link the reference to its source memories so the
underlying evidence stays reachable.

Update a reference when the truth changes, not on a calendar quota. A stale
reference is worse than no reference because it looks authoritative. When a
decision changes, the review step in the supersession procedure is where the
affected references get corrected.

## Using the tools

The canonical protocol shows exact calls. This section explains the
distinction between inspecting and using memory, and the capabilities that are
easy to miss.

### Inspect versus active use

- `memory_query` searches and lists memories. It does not record access or
  promote tiers.
- `memory_read` records access and promotes tiers by default.
- `memory_read` with `noPromote: true` returns the memory and its direct links
  without changing the tier. Use it when you only need to check a fact.

### Search

Start with a natural, focused question; one query is usually enough. Refine only
when the results are weak or ambiguous. For explicit constraints, `memory_query`
with `search` also accepts structured syntax: quoted phrases, boolean operators,
and a trailing `*` prefix. The [search engine](search-engine.md) page documents
the exact operator casing, supplied-query validation, and recovery. Results
include a `confidence` bucket and a `methods` list that names the channels that
matched. Use `space: "*"` to search across spaces.

Semantic recall is optional. RAG is off by default. When it is enabled,
natural-language queries can admit semantic-only matches at cosine similarity
0.6 or higher even when lexical results exist. Queries with explicit phrases,
prefixes, or operators stay lexical. Check `methods` before trusting a weak
semantic hit.

### Space orientation

`space_get` returns an orientation summary: total memory count, per-tier
counts, T1/T2/T3 previews, living references, and active checkpoints. T3
previews are bounded and report both the returned count and the total
availability, so the agent can orient without loading the whole archive.

### Maintenance

`memory_update` handles rename, content, tags, pinning, and one-tier moves. It
is the single maintenance entry point; there is no separate patch tool. Use it
for content changes and for the pin and tier operations described above.

## Worked maintenance examples

The examples below show complete maintenance decisions rather than isolated
calls.

### Change a decision

A project used a single SQLite file for task storage and now uses JSON Lines.
Update the current truth, keep the old decision as history, and link the pair.

1. Create `task-storage-decision-jsonl` with the new format and rationale.
2. Update `task-storage-decision` with its original tags plus
   `status:superseded`.
3. Link `task-storage-decision-jsonl` to `task-storage-decision` with
   `contradicts`.
4. Review the architecture and key-decisions references for stale wording.

### Record a bug and its root cause

After the fix is verified, add one atomic memory with the failure, the verified
cause, the location, and the recovery step. Link it to the module or decision
it touches. Do not record the debugging narrative; that belongs in the session
summary.

### Relink a relationship

A memory previously linked with `relates_to` is now known to implement a
decision. Call `link_create` again with the same directed pair and the new
label. The old label is replaced. If the direction was also wrong, create the
correct direction and delete the stale one.

### Promote and pin important knowledge

A release checklist is used in every release and must not be evicted. Update it
with `pinned: true` and `tierTransition: "promote"` in one call. Pinning
protects it from automatic eviction; the explicit transition places it in T1.
Confirm the returned memory shows the expected tier and pinned state.

### Hand off a session

Save a checkpoint with the goal, the pending work, the notes, and links to the
memories needed to recover. If work remains pending at session end, update the
checkpoint and leave it active; do not call `checkpoint_done` yet. When the
task is complete, convert the checkpoint with `checkpoint_done` into a
`session-*` summary at T3 tagged `type:session` and `cat:summary`, and include a
meaningful summary of what was done. The next session orients with `space_get`
and `checkpoint_query`, loads the checkpoint if the task continues, and falls
back to recent `type:session`/`cat:summary` memories when no checkpoint exists.
Do not create a placeholder checkpoint just to have one.

## Related documentation

- [Documentation index](README.md)
- Canonical protocol:
  [`src/resources/protocols/mind-cognitive-protocol.md`](../src/resources/protocols/mind-cognitive-protocol.md)
- [Search engine](search-engine.md)
- [Search benchmark methodology](search-benchmarks.md)
- [Skill-first distribution](skill-first-distribution.md)
- [Agent integration matrix](agent-integration-matrix.md)
- [Agent memory benchmark](../benchmarks/agent-memory/README.md)
