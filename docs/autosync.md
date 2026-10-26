# Autosync (experimental)

Autosync lets you mirror project spaces to a versioned `.mind/` directory so
you can review memory files in git, edit markdown on disk, and sync those
changes back into the local database. When a space is enabled, successful DB
mutations made through the CLI, web/API, or MCP also export the affected space
back to `.mind/spaces/<hash>/` as a non-blocking side effect.

<!-- prettier-ignore -->
> [!NOTE]
> This is an experimental feature currently under active development.

Set up autosync with the following flow:

1. Run `mind sync init` to create `.mind/config.yml` and `.mind/.gitignore`.
2. Review or edit `.mind/config.yml` to choose which spaces are configured.
3. Run `mind sync enable --space <name>` for the project space you want to
   sync.
4. Optional: Run `mind sync serve --space <name>` to start the watcher in the
   current terminal, or rely on MCP startup to auto-start watchers for enabled
   spaces.

The `.mind/` directory uses a file-based config and hashed space directories:

```text
.mind/
├── config.yml
├── .gitignore
└── spaces/
    └── a1b2c3d4/
        ├── manifest.json
        └── memory-name.md
```

Use these commands to manage autosync:

- `mind sync init`
- `mind sync status`
- `mind sync enable --space <name>`
- `mind sync disable --space <name>`
- `mind sync now --space <name>`
- `mind sync export --space <name>`
- `mind sync import --space <name>`
- `mind sync conflict --space <name> --strategy <strategy>`
- `mind sync remove --space <name>`
- `mind sync config`
- `mind sync serve --space <name>`

Conflict strategies:

- `db-wins` writes the DB version on real conflicts and prunes only files that
  the manifest marks as managed.
- `file-wins` preserves the file side on real conflicts. Automatic DB-to-file
  exports skip the conflicting file and record a warning.
- `latest-wins` uses normalized UTC timestamps as a tie-break after hash-based
  dirty detection. Near-future timestamps within five minutes are accepted for
  clock skew, while farther future timestamps are reported as unsafe and skipped
  instead of blindly overwriting.

Autosync writes manifest v2 files. Each manifest entry tracks managed file
ownership, the memory name, path, optional DB ID, canonical content and metadata
hashes, normalized UTC timestamps, file modification time, and the last sync
time. Hashes decide whether the DB side, file side, both sides, or neither side
changed since the common baseline. A file's mere existence isn't a conflict.

Example `.mind/config.yml`:

```yaml
# mind autosync config

version: 1

# Spaces to sync with this project
# To enable a new space, add it below with enabled: true
# Valid conflictResolution values: db-wins, file-wins, latest-wins
spaces:
  # projects/mind:
  #   enabled: true
  #   conflictResolution: db-wins
```

Current limitations and caveats:

- `mind sync status --space <name>` reports DB, file, and manifest counts,
  dirty DB/file drift, conflicts, tombstones, missing managed files, and the
  latest auto-export warning or error when manifest data is available.
- Existing-memory imports update supported metadata from files when the conflict
  strategy chooses file-to-DB: content, tags, tier, pinned state, and `links_to`
  links. Invalid metadata skips that file safely, unresolved links are reported,
  and frontmatter `name` does not rename existing memories.
- Exported `links_to` values are written to frontmatter, and imports recreate
  those links in the database.
- Deleting a synced markdown file does not auto-delete the corresponding
  database memory. `mind sync status` reports missing managed files as drift so
  you can restore or delete intentionally. DB-side deletes and renames prune only
  files that the manifest marks as managed.
- Automatic DB-to-file export warnings are recorded in logs and don't fail the
  original CLI, API, or MCP mutation. Explicit `sync export`, `sync import`, and
  `sync now` commands still report sync failures visibly.

Related: [cognitive memory lifecycle](cognitive-memory-lifecycle.md) and [CLI and MCP reference](interfaces.md).
