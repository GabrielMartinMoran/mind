#!/usr/bin/env bash
# T1 — credential mechanism + driver smoke (PAID; guarded).
#
# Mechanism (verified in T1): provider `opencode-go` reads the API key from the
# environment variable  OPENCODE_API_KEY  (from ~/.cache/opencode/models.json).
# The value is read from ~/.local/share/opencode/auth.json at runtime into the
# child env ONLY and is never printed or persisted.
#
# BUDGET: hard cap USD 0.05 for the whole smoke (<=3 minimal prompts).
#
# Usage:
#   bash 04-credential-smoke.sh --confirm          # run (spends money)
#   bash 04-credential-smoke.sh --sdk-only         # run only the free SDK host probe
set -uo pipefail
CONFIRM=0; SDK_ONLY=0
for a in "$@"; do [ "$a" = "--confirm" ] && CONFIRM=1; [ "$a" = "--sdk-only" ] && SDK_ONLY=1; done
if [ "$CONFIRM" = "0" ] && [ "$SDK_ONLY" = "0" ]; then
  echo "Refusing to spend money without --confirm (or use --sdk-only)."; exit 2
fi

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
PROBES="$ROOT/benchmarks/agent-memory/probes"
EVID="$PROBES/evidence"
RUN="$ROOT/benchmarks/agent-memory/.work/t1-run/oc-iso"
mkdir -p "$EVID" "$RUN"/{home,config,data,state,cache,workspace}

# read key into env only (never echo)
OPENCODE_API_KEY="$(bun -e 'const a=await Bun.file(process.env.HOME+"/.local/share/opencode/auth.json").json(); process.stdout.write(a["opencode-go"]?.key ?? "")')"
export OPENCODE_API_KEY
if [ -z "$OPENCODE_API_KEY" ]; then echo "No opencode-go key in auth.json"; exit 2; fi

cat > "$RUN/config-content.json" <<'JSON'
{
  "$schema": "https://opencode.ai/config.json",
  "model": "opencode-go/deepseek-v4.1-flash"
}
JSON
export HOME="$RUN/home" XDG_CONFIG_HOME="$RUN/config" XDG_DATA_HOME="$RUN/data" \
       XDG_STATE_HOME="$RUN/state" XDG_CACHE_HOME="$RUN/cache" \
       OPENCODE_DB="$RUN/data/opencode.db" OPENCODE_CONFIG_CONTENT="$(cat "$RUN/config-content.json")" \
       OPENCODE_DISABLE_PROJECT_CONFIG=1 OPENCODE_DISABLE_CLAUDE_CODE=1 OPENCODE_DISABLE_DEFAULT_PLUGINS=1 \
       OPENCODE_DISABLE_MODELS_FETCH=1 OPENCODE_DISABLE_AUTOCOMPACT=1
cd "$RUN/workspace"

if [ "$SDK_ONLY" = "0" ]; then
  echo "== CLI smoke: opencode run --format json (<= \$0.05 cap) =="
  printf 'Reply with exactly: PROBE-OK' | timeout 180 opencode run --standalone \
    --model opencode-go/deepseek-v4.1-flash --format json > "$EVID/smoke-cli.json" 2>"$EVID/smoke-cli.err.txt"
  echo "exit=$?"
  bun -e 'const fs=require("fs"); const l=fs.readFileSync(process.argv[1],"utf8").trim().split("\n").filter(Boolean); let cost=0; for(const x of l){try{const j=JSON.parse(x); if(j.cost!=null)cost+=j.cost; if(j.part?.cost!=null)cost+=j.part.cost;}catch{}} console.log("observed cost (USD):",cost);' "$EVID/smoke-cli.json"
fi

echo "== SDK in-process probe (free host; paid only if key valid) =="
( cd "$PROBES/sdk-probe" && SDK_PROBE_OUT="$EVID/sdk-probe.json" timeout 300 bun run probe.ts >/dev/null 2>&1 )
echo "sdk probe exit=$? -> $EVID/sdk-probe.json"

echo "== driver decision: see findings.md =="
