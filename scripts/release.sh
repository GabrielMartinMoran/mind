#!/usr/bin/env bash
set -euo pipefail

TYPE="${1:-}"
if [ $# -gt 0 ]; then
  shift
fi

usage() {
  echo "Usage: ./scripts/release.sh <patch|minor|major> [--simulate] [--notes-file <path>]"
}

if [ -z "$TYPE" ]; then
  usage
  exit 1
fi

if [ "$TYPE" != "patch" ] && [ "$TYPE" != "minor" ] && [ "$TYPE" != "major" ]; then
  echo "Invalid release type: $TYPE"
  echo "Use one of: patch, minor, major"
  exit 1
fi

SIMULATE=0
NOTES_FILE=""
while [ $# -gt 0 ]; do
  case "$1" in
    --simulate)
      SIMULATE=1
      shift
      ;;
    --notes-file)
      if [ -z "${2:-}" ]; then
        echo "Missing value for --notes-file"
        usage
        exit 1
      fi
      NOTES_FILE="$2"
      shift 2
      ;;
    *)
      echo "Unknown option: $1"
      usage
      exit 1
      ;;
  esac
done

run_cmd() {
  if [ "$SIMULATE" -eq 1 ]; then
    echo "[simulate] $*"
    return
  fi
  "$@"
}

ensure_changelog_exists() {
  if [ ! -f "CHANGELOG.md" ]; then
    echo "Missing CHANGELOG.md"
    exit 1
  fi
}

read_unreleased_block() {
  awk '
    /^## \[Unreleased\]$/ { in_unreleased=1; next }
    /^## \[/ { if (in_unreleased) exit }
    in_unreleased { print }
  ' CHANGELOG.md
}

ensure_changelog_has_unreleased_entries() {
  local block
  block="$(read_unreleased_block)"

  if ! printf '%s' "$block" | grep -Eq '[[:alnum:]]'; then
    echo "CHANGELOG.md has no unreleased entries. Add notes under ## [Unreleased]."
    exit 1
  fi

  if ! printf '%s' "$block" | grep -Eq '^### |^- '; then
    echo "CHANGELOG.md unreleased section should contain structured entries (### + bullets)."
    exit 1
  fi
}

promote_changelog_release() {
  local version="$1"
  local date
  date="$(date +%Y-%m-%d)"

  if [ "$SIMULATE" -eq 1 ]; then
    echo "[simulate] promote CHANGELOG.md Unreleased -> ${version} (${date})"
    return
  fi

  bun -e '
    const fs = require("fs");
    const version = process.argv[1];
    const date = process.argv[2];
    const file = "CHANGELOG.md";
    const text = fs.readFileSync(file, "utf8");
    const lines = text.split("\n");

    const unreleasedIdx = lines.findIndex((l) => l.trim() === "## [Unreleased]");
    if (unreleasedIdx === -1) {
      throw new Error("CHANGELOG.md is missing ## [Unreleased]");
    }

    let nextSectionIdx = -1;
    for (let i = unreleasedIdx + 1; i < lines.length; i++) {
      if (lines[i].startsWith("## [")) {
        nextSectionIdx = i;
        break;
      }
    }

    const unreleasedBody = lines.slice(unreleasedIdx + 1, nextSectionIdx === -1 ? lines.length : nextSectionIdx);
    const hasContent = unreleasedBody.join("\n").trim().length > 0;
    if (!hasContent) {
      throw new Error("Unreleased changelog section is empty");
    }

    while (unreleasedBody.length > 0 && unreleasedBody[0].trim() === "") unreleasedBody.shift();
    while (unreleasedBody.length > 0 && unreleasedBody[unreleasedBody.length - 1].trim() === "") unreleasedBody.pop();

    const before = lines.slice(0, unreleasedIdx + 1);
    const after = nextSectionIdx === -1 ? [] : lines.slice(nextSectionIdx);
    const releaseHeader = `## [${version}] - ${date}`;

    const out = [
      ...before,
      "",
      "",
      releaseHeader,
      "",
      ...unreleasedBody,
      "",
      ...after,
    ];

    fs.writeFileSync(file, out.join("\n").replace(/\n{3,}/g, "\n\n"));
  ' "$version" "$date"
}

require_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "Missing required command: $1"
    exit 1
  fi
}

current_branch() {
  git rev-parse --abbrev-ref HEAD
}

ensure_main_branch() {
  local branch
  branch="$(current_branch)"
  if [ "$branch" != "main" ]; then
    echo "Release must be run from main branch. Current: $branch"
    exit 1
  fi
}

check_main_branch_simulate() {
  local branch
  branch="$(current_branch)"
  if [ "$branch" != "main" ]; then
    echo "[simulate] warning: release is normally run from main (current: $branch)"
  fi
}

ensure_clean_tree() {
  if ! git diff --quiet || ! git diff --cached --quiet; then
    echo "Working tree is not clean. Commit or stash changes before releasing."
    exit 1
  fi
}

check_clean_tree_simulate() {
  if ! git diff --quiet || ! git diff --cached --quiet; then
    echo "[simulate] warning: working tree is dirty (real release would fail)"
  fi
}

read_current_version() {
  bun -e "const fs=require('fs'); const p=JSON.parse(fs.readFileSync('package.json','utf8')); console.log(p.version || '0.0.0');"
}

bump_version() {
  local current="$1"
  local major minor patch
  IFS='.' read -r major minor patch <<< "$current"

  case "$TYPE" in
    patch)
      patch=$((patch + 1))
      ;;
    minor)
      minor=$((minor + 1))
      patch=0
      ;;
    major)
      major=$((major + 1))
      minor=0
      patch=0
      ;;
  esac

  echo "${major}.${minor}.${patch}"
}

write_version() {
  local new_version="$1"
  if [ "$SIMULATE" -eq 1 ]; then
    echo "[simulate] update package.json version -> ${new_version}"
    return
  fi

  bun -e "const fs=require('fs'); const p=JSON.parse(fs.readFileSync('package.json','utf8')); p.version='${new_version}'; fs.writeFileSync('package.json', JSON.stringify(p, null, 2) + '\n');"
}

main() {
  require_cmd git
  require_cmd bun

  if [ "$SIMULATE" -eq 0 ]; then
    require_cmd gh
  else
    if ! command -v gh >/dev/null 2>&1; then
      echo "[simulate] warning: gh CLI is not installed"
    fi
  fi

  if [ "$SIMULATE" -eq 1 ]; then
    check_main_branch_simulate
    check_clean_tree_simulate
  else
    ensure_main_branch
    ensure_clean_tree
  fi
  ensure_changelog_exists
  ensure_changelog_has_unreleased_entries

  local current_version
  current_version="$(read_current_version)"
  local next_version
  next_version="$(bump_version "$current_version")"
  local tag="v${next_version}"

  echo "Current version: ${current_version}"
  echo "Next version:    ${next_version}"
  echo "Release type:    ${TYPE}"

  if git rev-parse "$tag" >/dev/null 2>&1; then
    echo "Tag already exists: $tag"
    exit 1
  fi

  run_cmd bun test test/
  write_version "$next_version"
  promote_changelog_release "$next_version"

  run_cmd git add package.json CHANGELOG.md
  run_cmd git commit -m "chore(release): ${tag}"
  run_cmd git tag "$tag"
  run_cmd git push origin main
  run_cmd git push origin "$tag"
  local notes_args=(--generate-notes)
  if [ -n "$NOTES_FILE" ]; then
    notes_args=(--notes-file "$NOTES_FILE")
  fi
  run_cmd gh release create "$tag" --title "$tag" "${notes_args[@]}"

  if [ "$SIMULATE" -eq 1 ]; then
    echo "[simulate] release flow complete (no changes were applied)"
  else
    echo "✅ Release complete: ${tag}"
  fi
}

main "$@"
