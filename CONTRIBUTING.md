# Contributing to Mind

Thanks for helping improve Mind. Contributions should make it easier for people
and AI coding agents to preserve, find, trust, and continue useful work over
time. Read [Mind's purpose and philosophy](docs/mind-philosophy.md) before
proposing a product change.

## Start here

- [Mind's purpose and philosophy](docs/mind-philosophy.md) — the product goal,
  principles, and boundaries.
- [AGENTS.md](AGENTS.md) — current architecture, repository conventions, and
  instructions for agents working in this codebase.
- [Cognitive memory lifecycle](docs/cognitive-memory-lifecycle.md) — the
  memory artifacts and how they are written, linked, maintained, and handed off.
- [Verification harness](docs/verification-harness.md) — local and hosted
  validation details.

## Agree on scope

Issues and pull requests are welcome. Small fixes, tests, and documentation
improvements can go directly to a pull request. For substantial changes to
product behavior, storage or schemas, public interfaces, agent integrations, or
the cognitive protocol, open an issue or discussion first. Describe the user
problem, the intended outcome, compatibility or migration impact, and how the
change will be verified.

Keep each pull request focused on one understandable outcome. Prefer a small
change that solves a demonstrated problem over a broad redesign without a
validated use case.

## Implementation expectations

- Follow the existing Bun and strict TypeScript setup, module boundaries, and
  patterns described in `AGENTS.md`. Keep public behavior consistent across
  the CLI, MCP server, HTTP API, and web UI where they expose the same
  capability.
- Treat persisted memories as user data. Preserve existing data when changing
  storage, cover migrations and failure paths with tests, and make multi-step
  writes safe against partial failure.
- Add deterministic tests for changed behavior and regressions. Prefer isolated
  fixtures and temporary databases. Tests should not depend on a live service
  unless they are explicitly opt-in integration tests.
- Keep user data and credentials out of commits, logs, fixtures, and benchmark
  exports. Do not commit local databases, `.env` files, API keys, or raw
  benchmark runs.
- Avoid new runtime dependencies unless they solve a clear problem. Update the
  relevant lockfile and explain the trade-off when adding one.
- When changing agent behavior, edit the canonical protocol at
  `src/resources/protocols/mind-cognitive-protocol.md` and keep its rendered
  skill and complete fallback in sync. Other instruction surfaces should point
  to the skill and fallback; see
  [Skill-first distribution](docs/skill-first-distribution.md).
- Keep living documentation current. Add every new living page to
  [docs/README.md](docs/README.md); update `AGENTS.md` for architecture,
  commands, configuration, or behavior; update `README.md` for user-facing
  usage; and add non-trivial or user-visible changes to
  [CHANGELOG.md](CHANGELOG.md) under `## [Unreleased]`.

## Verify your change

Use the full local harness before committing or pushing:

```bash
./scripts/run_full_test.sh
```

It runs the local hard gates and constrained review. Docker is advisory; see
[Verification harness](docs/verification-harness.md) for its outputs and
failure rules. The relevant direct commands are:

```bash
git diff --check
bun run format:check
bun run lint
bun run typecheck
bun test test/ web/test
```

For documentation changes, also check links directly:

```bash
bun test test/docs-links.spec.ts
```

Changes to `benchmarks/agent-memory/` should also pass that subproject's free
checks:

```bash
cd benchmarks/agent-memory
bun install --frozen-lockfile
bun run typecheck
bun test test
bun test experiments
```

Hosted CI runs two blocking jobs: root validation (including the high-severity
dependency audit, typecheck, formatting, lint, and tests) and the free
agent-memory benchmark checks (including its audit). Both jobs must pass before
merge. Do not report CI as passing until you have checked the hosted run for
the pushed commit. Paid benchmark stages are opt-in and are not CI gates; only
run them with the explicit budget and confirmation required by the benchmark
documentation. The RAG integration test also makes external API calls and
requires `OPENAI_API_KEY`; it is not a default test.

## Open a pull request

Target `develop` for normal contributions unless a maintainer directs
otherwise. In the pull request description, include:

- The problem and user-facing outcome.
- The main design or compatibility choices, especially for data or API changes.
- The tests and checks you ran, with any skipped checks clearly identified.
- Links to related issues and updated documentation or changelog entries.
- Screenshots or a short recording for visible web UI changes.

Keep review responses factual and constructive, and update the pull request when
review identifies a correctness, clarity, or documentation gap.
