# Mind's purpose and philosophy

Mind is a local, open-source persistent cognitive workspace for AI coding
agents. It helps useful context survive across sessions, tools, agents, and
context windows so work can resume with its intent, constraints, decisions,
discoveries, and unfinished tasks intact.

Mind gives people and agents a shared, inspectable memory layer. People remain
able to inspect and edit that memory through Mind's interfaces; connected
agents use it to orient, recall, learn, relate, maintain, and hand off context.
Mind organizes knowledge for future use while leaving reasoning and decisions
with the people and agents doing the work.

## What Mind is for

Mind helps an agent:

- Resume a project without rebuilding important context from scratch.
- Retrieve the decisions, constraints, fixes, patterns, and current references
  that apply to the work at hand.
- Preserve why a decision was made and what work remains, including across
  handoffs and context compaction.
- Find related knowledge and the source artifacts that contain fuller detail.

Mind is one local memory layer shared by its CLI, MCP server, HTTP API, and web
UI, backed by SQLite. Optional `.mind/` file sync can make project memories
inspectable and versionable alongside a project. The interfaces should express
one coherent memory model over the same source of truth.

## The working model

Mind gives different kinds of context different jobs:

| Artifact         | Job                                                              |
| ---------------- | ---------------------------------------------------------------- |
| Checkpoint       | Live work state: goal, next steps, blockers, and recovery links. |
| Session summary  | Historical record of a session accomplished.                     |
| Durable memory   | Reusable knowledge for future sessions.                          |
| Living reference | Maintained map of current truth for a project area.              |

Memory tiers make recent or frequently useful knowledge easier to reach:
**T1** is active, **T2** is nearby, and **T3** is the archive. A tier describes
use and access frequency; it does not measure truth, confidence, or quality.
Archived knowledge remains useful and can return to active use.

See [Cognitive memory lifecycle](cognitive-memory-lifecycle.md) for the full
writing, retrieval, linking, supersession, tier, and handoff guidance.

## Principles that guide Mind

### Remember selectively

Save context for its expected future usefulness, novelty, evidence, and
stability. Prefer a small, clear memory that changes what a future agent can do
over a dump of everything that happened.

### Retrieve for the work at hand

Recall should be bounded and relevant to the current question. Preserve enough
context to support a sound next action, and make uncertainty and evidence
visible instead of implying that every result is complete or current.

### Relate knowledge

Spaces, tags, and links help future agents see where information applies, what
it depends on, and what it changed. A memory should be understandable on its
own and easier to use when its important relationships are recorded.

### Keep current truth clear while preserving history

When a decision or fact changes, update the current reference and preserve the
reasoning behind the earlier state. Supersede old knowledge explicitly instead
of letting conflicting memories appear equally current.

### Carry unfinished work forward

A checkpoint describes work that can still be resumed. A session summary
records completed work. Durable memories carry knowledge forward, and living
references describe current truth. Keeping these purposes distinct makes
handoffs useful.

### Let maintenance follow real work

Update or relate memories when work reveals a change or uses important context.
Mind should not require routine sweeps, redundant writes, or checkpoints that
exist only to prove an agent started.

### Keep memory inspectable and user-controlled

The shared local store is the source of truth. Optional file sync and clear
interfaces help people inspect, correct, and version project memory. Mind
should not hide what it remembers or make external services a requirement for
basic use.

### Keep one canonical agent protocol

Agent guidance has one complete source in
[`mind-cognitive-protocol.md`](../src/resources/protocols/mind-cognitive-protocol.md)
and one complete `mind-management` skill. Other integration surfaces activate
that skill or use the complete fallback; they should not grow partial copies
that can drift. See [Skill-first distribution](skill-first-distribution.md).

## Boundaries

- Conversations provide evidence and context for selecting memories; Mind's
  durable store is not a transcript of every interaction.
- Project documents, code, and other primary artifacts remain authoritative
  for their detailed content. Mind can preserve the decision, status, and
  pointer that help an agent find and use those artifacts.
- Checkpoints and summaries have different lifetimes. A completed task is not
  left as live work, and historical evidence is not presented as current truth.
- Mind organizes context for agents. It does not make decisions on their
  behalf, guarantee perfect recall, or remove the need to verify current facts.

## A test for product changes

A change fits Mind when it improves useful continuity, relevant retrieval,
reliable handoffs, or the ability to inspect and maintain memory. It should
preserve the distinctions above, work with Mind's shared memory model, and avoid
adding unnecessary capture, maintenance, or setup burden.
