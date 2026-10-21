# Verification harness

Use `scripts/run_full_test.sh` to run the repo verification harness before you
commit or push. The harness is deterministic locally first, then runs a
constrained OpenCode review over generated artifacts, and finally runs Docker as
an advisory-only stage.

## What the harness does

The harness verifies the current working tree, not just staged files. It writes
machine-readable artifacts into a temp directory outside the repo by default,
then uses those artifacts as the only OpenCode review inputs.

Hard gates in v1:

- `git diff --check`
- `bun run format:check`
- `bun run lint`
- `bun run typecheck`
- `bun test test/ web/test`
- constrained `opencode run --format json` verdict stage

Docker is advisory in v1. The harness uses the existing installer smoke path if
Docker is available, but Docker warnings do not block a passing result.

## Hosted CI

GitHub Actions (`.github/workflows/main.yml`) is the hosted counterpart to the
local harness. It triggers on every push, including branch names that contain
`/`, every pull request to any base branch, and manual dispatch. There are no
branch or path filters.

The workflow has two independent free jobs. `validate` runs the root frozen
install, blocking high-severity audit, typecheck, format check, lint, and tests.
`benchmark-agent-memory` runs the subproject frozen install, blocking
high-severity audit, typecheck, tests, and experiments. No paid benchmark stage
runs in CI, and neither audit is suppressed.

A hosted run is required for merge evidence. Local gates and static workflow
assertions do not prove a hosted pass; observe and record the run URL and job
conclusions for the pushed commit before claiming CI success.

## Usage

Run the full harness from the repo root:

```bash
./scripts/run_full_test.sh
```

Optional: pin the artifact directory so another tool can inspect it.

```bash
./scripts/run_full_test.sh /tmp/mind-verify
```

## Outputs

The top-level script writes `summary.json` plus one `result.json` per stage:

- `local/result.json` — hard gate results and worktree artifacts
- `opencode/result.json` — parsed OpenCode verdict, raw output path, and inputs
- `docker/result.json` — advisory Docker outcome
- `summary.json` — overall pass/fail plus stage pointers

Important local artifacts include:

- `worktree_status.txt`
- `worktree_diff_stat.txt`
- `worktree_diff_numstat.txt`
- `worktree.patch`
- `untracked/*.patch` for untracked files
- `commands/*.stdout.txt` and `commands/*.stderr.txt` for gate outputs

## Failure classification

Use the JSON files for automation. v1 classification values are:

- `all-hard-gates-passed` / `hard-gate-failure` for local gates
- `verified-pass`, `model-verdict-fail`, `model-verdict-error`,
  `opencode-nonzero-exit`, and `verdict-missing` for OpenCode
- `installer-smoke-passed`, `installer-smoke-failed`,
  `docker-unavailable`, and `docker-disabled` for Docker
- `hard-gates-passed` / `hard-gates-failed` for the top-level summary

Treat any non-`pass` local or OpenCode status as blocking. Treat Docker
`warn` or `skip` results as advisory only.

## Deterministic OpenCode behavior

The OpenCode stage uses:

- `opencode run`
- `--format json`
- a dedicated `verification-harness` agent defined through
  `OPENCODE_CONFIG_CONTENT`
- `permission.* = deny` to prevent repo exploration and tool use
- attached machine-generated artifacts only
- prompt instructions sent through stdin so `--file` stays reserved for actual
  attachment paths
- no forced one-step cap, so the stage does not degrade into `Maximum Steps
Reached` prose instead of the required JSON verdict

Set `VERIFY_OPENCODE_MODEL` if you want the harness to force a specific model.
The harness otherwise relies on your normal OpenCode model resolution.

## Useful environment variables

- `VERIFY_ARTIFACT_DIR` — override the top-level artifact root
- `VERIFY_OPENCODE_MODEL` — pass `--model` to `opencode run`
- `VERIFY_DOCKER_ENABLED=0` — skip the Docker advisory stage
- `VERIFY_GATE_BUN_BIN` — override the Bun binary used for hard gates
- `VERIFY_BUN_BIN` — override the Bun binary used for harness JSON processing
