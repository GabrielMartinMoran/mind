# tasklog

A tiny Bun task tracker used as a benchmark fixture.

Tasks currently live **in memory** only, so they disappear when the process
exits. A future `export` command (`bun run export`) must persist them.

## Files

- `src/tasks.ts` — the in-memory task store.
- `src/cli.ts` — a minimal command-line entry point (`add` / `list`).
