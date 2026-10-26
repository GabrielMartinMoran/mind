# Mind documentation

This index is the entry point for Mind's living documentation. A living page
describes current behavior and is kept current with the code. Execution, merge,
and validation reports belong in `.pas/`, not here. Only exceptional historical
evidence with durable technical value is retained under `docs/history/`; it is
frozen and is not current truth. The maintenance policy is in
[AGENTS.md §6](../AGENTS.md#6-documentation-philosophy-and-maintenance).

## Project

- [Mind's purpose and philosophy](mind-philosophy.md) — states what Mind is
  for, its product principles, and its boundaries.
- [Contributing](../CONTRIBUTING.md) — contribution workflow, quality
  expectations, verification gates, and pull request guidance.

## Memory

- [Cognitive memory lifecycle](cognitive-memory-lifecycle.md) — explains the
  memory model, tiers, lifecycle, quality rules, supersession, linking, and
  living references.

## Search

- [Search engine](search-engine.md) — explains the end-to-end pipeline: query
  grammar and validation, the eight result methods, admission, fusion and
  confidence, surface filters and pagination, schema v10 storage, fuzzy
  prefix-3, and semantic/RAG behavior.
- [Search benchmark methodology](search-benchmarks.md) — explains how to
  measure search quality, latency, and index size, and how to reproduce it.

## Web

- [Web UI](web-ui.md) — maps the browser app: module layers, URL contract,
  unified search, graph filtering, accessibility, design tokens, testing, and
  known debt.

## Agents and setup

- [Skill-first distribution](skill-first-distribution.md) — explains the
  `mind-management` skill as the single source of truth, activation pointers,
  and the exact-name installation and update model.
- [Agent integration matrix](agent-integration-matrix.md) — records the MCP and
  skill paths, instruction support, hooks, and validation status for every
  supported client.

## Development

- [Verification harness](verification-harness.md) — explains how to run the
  local hard gates, the constrained review stage, and the advisory Docker stage.

## Benchmarks

- [OmniMemEval / LongMemEval-S](../benchmarks/omnimemeval/README.md) —
  external answer-quality benchmark, comparison provenance, and manual-only
  GitHub Actions workflow (paid; not part of CI).
- [Agent memory benchmark](../benchmarks/agent-memory/README.md) — documents the
  independent harness that measures whether Mind helps a real OpenCode agent.

## Releases

- [v1.6.0 release notes](release-notes/v1.6.0.md) — memory discipline and search
  fixes.
- [v1.5.1 release notes](release-notes/v1.5.1.md) — Neural Map UUID layout fix.
- [v1.5.0 release notes](release-notes/v1.5.0.md) — autosync, setup refresh, and
  database migration safety.

## Exceptional historical evidence

These three reports are retained because they contain durable measurements,
rejected alternatives, or open research questions that the living pages
summarize but do not reproduce in full. Each keeps its frozen banner and points
to the living page that describes current behavior.

- [00004 search optimization report](history/00004-search-optimization/search-optimization-report.md)
  — measured trigram and fuzzy optimization results, schema v10 decisions, and
  rejected alternatives.
- [00005 search next-steps research](history/00005-search-followup/search-next-steps-research.md)
  — synthetic scalability prototype, admission/false-positive analysis, and
  deferred search strategies.
- [00009 memory recall improvement analysis](history/00009-memory-recall-investigation/memory-recall-improvement-analysis.md)
  — memory recall experiments, embedding cost findings, and write-side gaps.
