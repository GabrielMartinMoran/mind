#!/usr/bin/env bash
# T1 — Platform & isolation probe (FREE steps only; no LLM calls).
# Re-runnable. Writes grep-safe evidence into probes/evidence/ and prints a
# PASS/FAIL summary per criterion.
#
# Usage:  bash benchmarks/agent-memory/probes/run-t1-probes.sh
#
# Paid credential/driver smoke is separate: 04-credential-smoke.sh (guarded).
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"   # repo root
PROBES="$ROOT/benchmarks/agent-memory/probes"
EVID="$PROBES/evidence"
WORK="$ROOT/benchmarks/agent-memory/.work/worktrees"
RUN="$ROOT/benchmarks/agent-memory/.work/t1-run"
mkdir -p "$EVID" "$RUN"

V9_SHA="36d2f1e"; V10_SHA="c7029b3"
PASS=0; FAIL=0
result() { # result <name> <ok:0|1> <detail>
  if [ "$2" = "0" ]; then echo "  PASS  $1 — $3"; PASS=$((PASS+1));
  else echo "  FAIL  $1 — $3"; FAIL=$((FAIL+1)); fi
}
# Redact a leading /home/<user> or /Users/<user> so persisted evidence never
# leaks an absolute home path (raw evidence is committed to git).
sanitize_home() { sed -E 's#/(home|Users)/[^/]+#~#g'; }
# Post-capture pass: apply sanitize_home to EVERY evidence capture (txt + json)
# so no evidence write can leak an absolute home path. Replacing the home prefix
# with "~" leaves JSON valid (the substitution stays inside the string value).
sanitize_evidence() {
  local f
  for f in "$EVID"/*.txt "$EVID"/*.json; do
    [ -f "$f" ] || continue
    sanitize_home < "$f" > "$f.sanitize.tmp" && mv "$f.sanitize.tmp" "$f"
  done
}
free_port() { python3 - <<'PY' 2>/dev/null || echo 39555
import socket;s=socket.socket();s.bind(("127.0.0.1",0));print(s.getsockname()[1]);s.close()
PY
}

echo "== T1 probes: versions =="
{
  echo "{"
  echo "  \"opencode_path\": \"$(command -v opencode | sanitize_home)\","
  echo "  \"opencode_version\": \"$(opencode --version 2>/dev/null | head -1)\","
  echo "  \"bun_version\": \"$(bun --version)\","
  echo "  \"repo_head\": \"$(git -C "$ROOT" rev-parse HEAD)\","
  echo "  \"repo_branch\": \"$(git -C "$ROOT" branch --show-current)\""
  echo "}"
} > "$EVID/versions.json"
cat "$EVID/versions.json"

echo "== T1 probes: worktrees + schema =="
for V in v9 v10; do
  WT="$WORK/$V"
  if [ ! -d "$WT/.git" ] && [ ! -f "$WT/.git" ]; then
    SHA=$V9_SHA; [ "$V" = "v10" ] && SHA=$V10_SHA
    git -C "$ROOT" worktree add --detach "$WT" "$SHA" >/dev/null 2>&1
  fi
done
for V in v9 v10; do
  WT="$WORK/$V"
  [ -d "$WT/node_modules" ] || (cd "$WT" && timeout 300 bun install >/dev/null 2>&1)
done

: > "$EVID/schema-checks.json"
for V in v9 v10; do
  WT="$WORK/$V"
  TMP="$RUN/schema-$V"; rm -rf "$TMP"; mkdir -p "$TMP"
  MIND_DATA_DIR="$TMP" MIND_DB_PATH="$TMP/mind.db" timeout 60 "$WT/mind" status >/dev/null 2>&1
  INFO=$(bun -e '
    const {Database}=require("bun:sqlite");
    const db=new Database(process.argv[1],{readonly:true});
    const v=db.query("SELECT value FROM meta WHERE key=?").get("schema_version");
    const trig=db.query("SELECT name FROM sqlite_master WHERE name=?").get("memories_fts_trigram");
    process.stdout.write(JSON.stringify({schema_version:Number(v?.value),has_trigram:!!trig}));
  ' "$TMP/mind.db")
  SHA=$(git -C "$WT" rev-parse HEAD)
  LOCK=$( [ -f "$WT/bun.lock" ] && echo yes || echo no )
  echo "  $V: sha=$SHA schema=$INFO lock=$LOCK" | tee -a "$EVID/schema-checks.txt"
  echo "{\"version\":\"$V\",\"sha\":\"$SHA\",\"lockfile\":\"$LOCK\",\"info\":$INFO}" >> "$EVID/schema-checks.json"
done
V9_SCHEMA=$(grep -o '"schema_version":8' "$EVID/schema-checks.json" | head -1)
[ -n "$V9_SCHEMA" ] && result "v9 schema=8 & no trigram" 0 "verified" || result "v9 schema" 1 "unexpected"
grep -q '"has_trigram":false' "$EVID/schema-checks.json" && result "v9 no trigram" 0 ok || result "v9 trigram" 1 bad
grep -q '"schema_version":10' "$EVID/schema-checks.json" && grep -q '"has_trigram":true' "$EVID/schema-checks.json" \
  && result "v10 schema=10 & trigram" 0 verified || result "v10 schema" 1 unexpected

echo "== T1 probes: A1 /api/search fixtures =="
for V in v9 v10; do
  WT="$WORK/$V"
  TMP="$RUN/a1-$V"; rm -rf "$TMP"; mkdir -p "$TMP"
  export MIND_DATA_DIR="$TMP" MIND_DB_PATH="$TMP/mind.db"
  "$WT/mind" create locomo/probe "probe" --tags probe >/dev/null 2>&1
  "$WT/mind" add locomo/probe "D1:1" "probe memory one hello benchmark" --tags probe --tier 3 >/dev/null 2>&1
  "$WT/mind" add locomo/probe "D1:2" "probe memory two world benchmark" --tags probe --tier 3 >/dev/null 2>&1
  PORT=$(free_port)
  ( cd "$WT" && MIND_DATA_DIR="$TMP" MIND_DB_PATH="$TMP/mind.db" MIND_PORT=$PORT nohup "$WT/mind" serve start --port $PORT >"$RUN/a1-$V-serve.log" 2>&1 & echo $! > "$RUN/a1-$V.pid" )
  sleep 3
  curl -s --max-time 10 "http://127.0.0.1:$PORT/api/search?q=probe&space=locomo/probe" > "$EVID/a1-$V-raw.json"
  kill "$(cat "$RUN/a1-$V.pid")" >/dev/null 2>&1; sleep 1
  pkill -f "serve start --port $PORT" >/dev/null 2>&1
  unset MIND_DATA_DIR MIND_DB_PATH
  bun -e '
    const fs=require("fs"); const arr=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));
    const keys=arr.length?Object.keys(arr[0]).sort():[];
    fs.writeFileSync(process.argv[2], JSON.stringify({items:arr.length,fields:keys},null,2));
  ' "$EVID/a1-$V-raw.json" "$EVID/a1-$V-fields.json"
done
echo "  v9 fields:  $(bun -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).fields.join(","))' "$EVID/a1-v9-fields.json")"
echo "  v10 fields: $(bun -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).fields.join(","))' "$EVID/a1-v10-fields.json")"
grep -q '"content"' "$EVID/a1-v9-fields.json" && grep -q '"space_name"' "$EVID/a1-v9-fields.json" \
  && result "v9 exposes content+space_name" 0 ok || result "v9 fields" 1 bad
for f in score confidence methods; do grep -q "\"$f\"" "$EVID/a1-v10-fields.json" || result "v10 field $f" 1 missing; done
grep -q '"score"' "$EVID/a1-v10-fields.json" && grep -q '"confidence"' "$EVID/a1-v10-fields.json" && grep -q '"methods"' "$EVID/a1-v10-fields.json" \
  && result "v10 exposes score/confidence/methods" 0 ok || result "v10 additive fields" 1 bad
echo "  NOTE: v9 uses 'rank' (similarity is undefined with RAG off) — see findings.md deviation."

echo "== T1 probes: MIND_DB_PATH parent-dir behavior =="
WT="$WORK/v10"
BAD="$RUN/nonexistent-parent/sub/mind.db"; rm -rf "$RUN/nonexistent-parent"
OUT=$(MIND_DB_PATH="$BAD" timeout 30 "$WT/mind" status 2>&1); RC=$?
if [ $RC -ne 0 ] && echo "$OUT" | grep -qi "unable to open database file\|SQLITE_CANTOPEN"; then
  result "MIND_DB_PATH bad parent fails" 0 "SQLITE_CANTOPEN"; echo "$OUT" | head -5 > "$EVID/dbpath-bad-parent.txt"
else result "MIND_DB_PATH bad parent" 1 "rc=$RC"; fi
GOOD="$RUN/autocreate-dir"; rm -rf "$GOOD"
MIND_DATA_DIR="$GOOD" timeout 30 "$WT/mind" status >/dev/null 2>&1; RC=$?
if [ $RC -eq 0 ] && [ -f "$GOOD/mind.db" ]; then result "MIND_DATA_DIR auto-creates" 0 ok
else result "MIND_DATA_DIR auto-create" 1 "rc=$RC"; fi
{ echo "MIND_DB_PATH with non-existent parent => failure:"; cat "$EVID/dbpath-bad-parent.txt" 2>/dev/null; echo; echo "MIND_DATA_DIR => auto-created parent and succeeded."; } > "$EVID/dbpath-behavior.txt"

echo "== T1 probes: MCP stdio JSON-RPC (v9 + v10) =="
for V in v9 v10; do
  WT="$WORK/$V"; MDB="$RUN/mcp-$V"; rm -rf "$MDB"; mkdir -p "$MDB"
  SYNC="$RUN/mcp-$V-sync"; mkdir -p "$SYNC"
  MIND_DATA_DIR="$MDB" MIND_DB_PATH="$MDB/mind.db" "$WT/mind" create locomo/probe "probe" --tags probe >/dev/null 2>&1
  MIND_DATA_DIR="$MDB" MIND_DB_PATH="$MDB/mind.db" "$WT/mind" add locomo/probe "D1:1" "probe memory one hello benchmark" --tags probe --tier 3 >/dev/null 2>&1
  MIND_BIN="$WT/mind" MIND_DB_PATH="$MDB/mind.db" MIND_DATA_DIR="$MDB" MIND_SYNC_ROOT="$SYNC" \
    MCP_PROBE_OUT="$EVID/mcp-$V.json" timeout 60 bun run "$PROBES/mcp-stdio-probe.ts" >/dev/null 2>&1
  if bun -e 'const j=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")); process.exit(j.pass?0:1)' "$EVID/mcp-$V.json"; then
    result "MCP stdio $V" 0 "$(bun -e 'const j=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")); console.log(j.toolCount+" tools, query ok")' "$EVID/mcp-$V.json")"
  else result "MCP stdio $V" 1 "probe failed"; fi
done

echo "== T1 probes: OpenCode isolation (free) =="
ISO="$RUN/oc-iso"; rm -rf "$ISO"
mkdir -p "$ISO"/{home,config,data,state,cache,workspace}
cat > "$ISO/config-content.json" <<'JSON'
{
  "$schema": "https://opencode.ai/config.json",
  "model": "opencode-go/deepseek-v4.1-flash"
}
JSON
export HOME="$ISO/home" XDG_CONFIG_HOME="$ISO/config" XDG_DATA_HOME="$ISO/data" \
       XDG_STATE_HOME="$ISO/state" XDG_CACHE_HOME="$ISO/cache" \
       OPENCODE_DB="$ISO/data/opencode.db" OPENCODE_CONFIG_CONTENT="$(cat "$ISO/config-content.json")" \
       OPENCODE_DISABLE_PROJECT_CONFIG=1 OPENCODE_DISABLE_CLAUDE_CODE=1 OPENCODE_DISABLE_DEFAULT_PLUGINS=1 \
       OPENCODE_DISABLE_MODELS_FETCH=1 OPENCODE_DISABLE_AUTOCOMPACT=1
cd "$ISO/workspace"
# Use a private service port FIRST (default 49374 may be taken by the user's service).
opencode service set port "$(free_port)" >/dev/null 2>&1
opencode debug paths > "$EVID/isolation-paths.txt" 2>&1
# path containment check: every resolved state/config path must live under $ISO
# (the `tmp` line points at the OS temp dir and is intentionally excluded)
if grep -vE "^tmp[[:space:]]" "$EVID/isolation-paths.txt" | awk '{print $2}' | grep -v "^$ISO" | grep -q .; then
  result "isolation: all paths under run dir" 1 "leak"; else result "isolation: all paths under run dir" 0 ok; fi
opencode debug config > "$EVID/isolation-config.json" 2>/dev/null
opencode mcp list > "$EVID/isolation-mcp-list.txt" 2>&1
opencode session list --format json > "$EVID/isolation-sessions.json" 2>&1
[ -s "$EVID/isolation-sessions.json" ] || echo "[]" > "$EVID/isolation-sessions.json"
grep -qi "no mcp servers configured" "$EVID/isolation-mcp-list.txt" && result "isolation: zero MCP" 0 ok || result "isolation: zero MCP" 1 "unexpected"
[ "$(cat "$EVID/isolation-sessions.json" | tr -d '[:space:]')" = "[]" ] && result "isolation: empty sessions" 0 ok || result "isolation: empty sessions" 1 "leak"
# agent/skill/plugin via api (uses the private service port; warm up first)
opencode api get /api/info >/dev/null 2>&1; sleep 2
opencode api get /api/agent  > "$EVID/isolation-agents.json" 2>/dev/null
opencode api get /api/skill   > "$EVID/isolation-skills.json" 2>/dev/null
opencode api get /api/plugin  > "$EVID/isolation-plugins.json" 2>/dev/null
opencode api get /api/mcp     > "$EVID/isolation-api-mcp.json" 2>/dev/null
opencode api get /api/agent >/dev/null 2>&1
opencode service stop >/dev/null 2>&1
for f in isolation-agents isolation-skills isolation-plugins; do
  bun -e '
    const fs=require("fs"); const j=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));
    const d=j.data||[]; console.log(d.length+" entries"); fs.writeFileSync(process.argv[1].replace(".json","-ids.json"), JSON.stringify(d.map(x=>x.id||x.name),null,0));
  ' "$EVID/$f.json" >> "$EVID/isolation-summary.txt" 2>&1
done
chmod 644 "$EVID"/* 2>/dev/null
unset OPENCODE_CONFIG_CONTENT OPENCODE_DB HOME XDG_CONFIG_HOME XDG_DATA_HOME XDG_STATE_HOME XDG_CACHE_HOME

echo "== T1 probes: sanitize evidence (strip home prefix) =="
sanitize_evidence
grep -RlE "/(home|Users)/" "$EVID" 2>/dev/null | grep -v node_modules && echo "  WARN: home path still present" || echo "  OK: no home paths in evidence"

echo
echo "== T1 FREE SUMMARY: PASS=$PASS FAIL=$FAIL =="
[ "$FAIL" = "0" ] && echo "ALL FREE CRITERIA PASS" || echo "SOME FREE CRITERIA FAILED"
