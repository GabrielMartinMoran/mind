# releasetool

A tiny Bun release helper used as a benchmark fixture.

The project keeps its release process in team knowledge rather than in the
repository: the operational checklist and background notes are stored as
project memories. The repository only contains the tooling itself.

## Files

- `package.json` — project manifest (`bun test`, `bun run build`).
- `src/publish.ts` — the release publishing helper.
