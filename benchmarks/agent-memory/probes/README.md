# T1 probes — re-runnable

Everything here is safe to re-run. Free probes make no LLM calls; the paid
driver smoke is guarded.

| File                     | Purpose                                                                                                                                                                                      |
| ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `run-t1-probes.sh`       | Version info, worktree + schema checks (v9=8 / v10=10), `/api/search` raw fixtures, `MIND_DB_PATH` behavior, MCP stdio JSON-RPC (both versions), OpenCode isolation dumps. Prints PASS/FAIL. |
| `mcp-stdio-probe.ts`     | Speaks minimal MCP JSON-RPC to a `mind mcp` server over stdio; verifies clean framing, 18 tools, and a `memory_query`.                                                                       |
| `04-credential-smoke.sh` | Credential mechanism + driver smoke. **Paid** — requires `--confirm`; `--sdk-only` runs the free embedded-host probe.                                                                        |
| `sdk-probe/`             | In-process host probe; it has no package of its own and resolves `@opencode/sdk@2.0.28` from the harness subproject.                                                                         |

## Run (free)

```sh
bash benchmarks/agent-memory/probes/run-t1-probes.sh
```

Evidence is written to `probes/evidence/` (grep-safe, no secrets). After every
capture the script runs a final sanitize pass over all `evidence/*.txt` and
`evidence/*.json`, rewriting any absolute `/home/<user>`/`/Users/<user>` prefix
to `~` (the substitution stays inside string values, so JSON remains valid). This
covers captures that cannot be sanitized inline (e.g. `opencode debug paths`, the
MCP probe dumps, isolation JSON). It then re-checks with
`grep -RlE "/(home|Users)/" evidence/` and warns if any home path survives. Read
`evidence/findings.md` for the PASS/FAIL table, driver decision and isolation
recipe.

## Run (paid driver smoke — spends money)

```sh
# only after the OpenCode Go API key is valid:
bash benchmarks/agent-memory/probes/04-credential-smoke.sh --confirm
```

Requires `OPENCODE_API_KEY` (derived at runtime from
`~/.local/share/opencode/auth.json`, never printed). Hard cap: USD 0.05.
