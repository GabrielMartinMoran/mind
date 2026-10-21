# Mind documentation

This index is the entry point for Mind's living documentation. A living page
describes current behavior and is kept current with the code. Historical reports
are frozen evidence and live under [`history/`](history/); they are not current
truth. The maintenance policy is in
[AGENTS.md §6](../AGENTS.md#6-documentation-philosophy-and-maintenance).

## Memory

- [Cognitive memory lifecycle](cognitive-memory-lifecycle.md) — explains the
  memory model, tiers, lifecycle, quality rules, supersession, linking, and
  living references.

## Search

- [Search engine](search-engine.md) — describes the current channels,
  admission rules, schema v10 storage, the fuzzy prefix-3 limit, and the
  performance envelope.
- [Search benchmark methodology](search-benchmarks.md) — explains how to
  measure search quality, latency, and index size, and how to reproduce it.

## Agents and setup

- [Skill-first distribution](skill-first-distribution.md) — explains the single
  canonical protocol, the `mind-management` skill, brief activation, and the
  exact-name installation and update model.
- [Agent integration matrix](agent-integration-matrix.md) — records the MCP and
  skill paths, instruction support, hooks, and validation status for every
  supported client.

## Development

- [Verification harness](verification-harness.md) — explains how to run the
  local hard gates, the constrained review stage, and the advisory Docker stage.

## Benchmarks

- [Agent memory benchmark](../benchmarks/agent-memory/README.md) — documents the
  independent harness that measures whether Mind helps a real OpenCode agent.

## Releases

- [v1.6.0 release notes](release-notes/v1.6.0.md) — memory discipline and search
  fixes.
- [v1.5.1 release notes](release-notes/v1.5.1.md) — Neural Map UUID layout fix.
- [v1.5.0 release notes](release-notes/v1.5.0.md) — autosync, setup refresh, and
  database migration safety.

## Historical reports

See [`history/`](history/) for frozen reports grouped by feature; each file
states its feature, freeze date, and the living page that supersedes it.
