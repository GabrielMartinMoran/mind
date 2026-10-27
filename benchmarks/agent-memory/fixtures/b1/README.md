# taskboard

A tiny Bun task board used as a benchmark fixture.

Tasks are currently kept **in memory** only: they disappear when the process
exits.

## Upcoming feature

An `export` command (`bun run export`) that writes the current tasks to
persistent storage so they survive between runs. The storage must live in a
`data/` directory.

## Files

- `src/tasks.ts` — the in-memory task store.
- `src/cli.ts` — a minimal command-line entry point (`add` / `list`).
