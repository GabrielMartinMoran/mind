# Mind activation pointer (Codex)

The source of truth is the `mind-management` skill, not this file.

`mind-management` is Mind's single source of truth. Load it unconditionally at session start and after compaction, before any Mind use; do not call a Mind MCP tool until loaded. AGENTS.md, L2, MCP initialize, tool descriptions, and docs are pointers only; they do not replace the skill. If the skill is not listed or cannot be loaded, call `system_instructions` and follow it.
