# taskqueue

A tiny Bun task queue used as a benchmark fixture.

Tasks are currently persisted in a **single SQLite database** at
`data/tasks.db`. That is the project's long-standing storage decision.

## Files

- `package.json` — project manifest (`bun run list`).
- `src/tasks.ts` — the task model and the current SQLite persistence note.
- `src/cli.ts` — a minimal command-line entry point.
