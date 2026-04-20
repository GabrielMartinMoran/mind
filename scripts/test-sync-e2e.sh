#!/bin/bash
set -e

# ── Mind Autosync E2E Integration Test ──

# Setup
TEST_DIR="/tmp/mind-sync-e2e-$$"
DB_PATH="$TEST_DIR/test.db"
mkdir -p "$TEST_DIR"

export MIND_DB_PATH="$DB_PATH"

echo "=== Mind Autosync E2E Test ==="
echo "Test directory: $TEST_DIR"

# 1. Inicializar mind y crear space
echo "1. Creating project space..."
./mind create projects/test "Test project space" --tags type:project

# 2. Agregar memories de prueba (T1, T2, T3)
echo "2. Adding memories in different tiers..."
./mind add projects/test memory-t1 "Content T1" --tags cat:test --tier 1
./mind add projects/test memory-t2 "Content T2" --tags cat:test --tier 2
./mind add projects/test memory-t3 "Content T3" --tags cat:test --tier 3

# 3. Habilitar sync y exportar
echo "3. Enabling sync and exporting..."
./mind sync enable --space projects/test --path "$TEST_DIR/markdown"

# 4. Verificar archivos exportados
echo "4. Verifying exported files..."
# Files are in .mind/spaces/<hash>/
SPACE_HASH=$(echo -n "projects/test" | sha256sum | cut -c1-8)
COUNT=$(ls "$TEST_DIR/markdown/.mind/spaces/$SPACE_HASH"/*.md 2>/dev/null | wc -l)
if [ "$COUNT" -ne 3 ]; then
  echo "FAIL: Expected 3 files, got $COUNT"
  exit 1
fi

# 5. Verificar frontmatter en archivos
echo "5. Verifying frontmatter..."
for file in "$TEST_DIR/markdown/.mind/spaces/$SPACE_HASH"/*.md; do
  if ! head -1 "$file" | grep -q "^---$"; then
    echo "FAIL: $file missing frontmatter start"
    exit 1
  fi
done

# 6. Modificar archivo externamente
echo "6. Testing external modification detection..."
# Calculate space hash (same algorithm as src/sync/normalize.ts)
SPACE_HASH=$(echo -n "projects/test" | sha256sum | cut -c1-8)
cat > "$TEST_DIR/markdown/.mind/spaces/$SPACE_HASH/external.md" << 'EOF'
---
id: 999
space: projects/test
name: external-memory
tier: 2
pinned: false
tags:
  - cat:external
links_to: []
created_at: 2024-01-01 00:00:00
changed_at: 2024-01-01 00:00:00
---
External content added manually
EOF

# 7. Importar cambio externo
echo "7. Importing external change..."
./mind sync import --space projects/test --path "$TEST_DIR/markdown"

# 8. Verificar que se importó
echo "8. Verifying import..."
if ! ./mind read projects/test external-memory > /dev/null 2>&1; then
  echo "FAIL: External memory not imported"
  exit 1
fi

# 9. Verificar conflict resolution
echo "9. Testing conflict resolution..."
./mind sync conflict --space projects/test --strategy file-wins
STATUS=$(./mind sync status --space projects/test)
if ! echo "$STATUS" | grep -q "file-wins"; then
  echo "FAIL: Conflict strategy not updated"
  exit 1
fi

# 10. Verificar sync status
echo "10. Verifying sync status..."
STATUS_OUTPUT=$(./mind sync status --space projects/test)
echo "$STATUS_OUTPUT"
if ! echo "$STATUS_OUTPUT" | grep -q "projects/test"; then
  echo "FAIL: sync status doesn't show space"
  exit 1
fi

# ─────────────────────────────────────────────────────
# Test 7: Git pull simulation — new files from teammate
# ─────────────────────────────────────────────────────
echo ""
echo "=== Test 7: Git pull simulation — new files from teammate ==="

TEST7_DIR="/tmp/mind-sync-e2e-test7-$$"
TEST7_DB="$TEST7_DIR/test7.db"
mkdir -p "$TEST7_DIR"
export MIND_DB_PATH="$TEST7_DB"

echo "7.1. Creating team space..."
./mind create projects/test-team "Team sync test" --tags type:project

echo "7.2. Enabling sync..."
./mind sync enable --space projects/test-team --path "$TEST7_DIR/markdown"

echo "7.3. Adding memory from team member A..."
./mind add projects/test-team team-member-a "Content from team member A" --tags cat:team

echo "7.4. Exporting to simulate git push..."
./mind sync now --space projects/test-team

# Calculate space hash
SPACE_HASH=$(echo -n "projects/test-team" | sha256sum | cut -c1-8)
SYNC_DIR="$TEST7_DIR/markdown/.mind/spaces/$SPACE_HASH"

echo "7.5. Simulating git pull — adding new file from team member B..."
cat > "$SYNC_DIR/team-member-b.md" << 'EOF'
---
id: 9999
space: projects/test-team
name: team-member-b
tier: 2
pinned: false
tags:
  - cat:team
links_to: []
created_at: 2024-01-01 00:00:00
changed_at: 2024-01-15 10:00:00
---
Content from team member B that came via git pull.
EOF

echo "7.6. Importing new file (simulating sync import after git pull)..."
./mind sync import --space projects/test-team --path "$TEST7_DIR/markdown"

echo "7.7. Verifying DB has the new memory..."
CONTENT=$(./mind read projects/test-team team-member-b 2>/dev/null) || true
if ! echo "$CONTENT" | grep -q "Content from team member B that came via git pull"; then
  echo "FAIL: team-member-b not imported from file"
  echo "Got: $CONTENT"
  rm -rf "$TEST7_DIR"
  exit 1
fi

echo "7.8. Cleanup test 7..."
./mind sync disable --space projects/test-team
rm -rf "$TEST7_DIR"
echo "Test 7 PASSED"

# ─────────────────────────────────────────────────────────────────
# Test 8: Git pull simulation — conflict resolution with db-wins
# ─────────────────────────────────────────────────────────────────
echo ""
echo "=== Test 8: Git pull simulation — conflict resolution with db-wins ==="

TEST8_DIR="/tmp/mind-sync-e2e-test8-$$"
TEST8_DB="$TEST8_DIR/test8.db"
mkdir -p "$TEST8_DIR"
export MIND_DB_PATH="$TEST8_DB"

echo "8.1. Creating conflict test space..."
./mind create projects/test-conflict "Conflict test space" --tags type:project

echo "8.2. Enabling sync..."
./mind sync enable --space projects/test-conflict --path "$TEST8_DIR/markdown"

echo "8.3. Creating memory and exporting..."
./mind add projects/test-conflict conflict-test "Original content" --tags cat:test
./mind sync now --space projects/test-conflict --path "$TEST8_DIR/markdown"

SPACE_HASH=$(echo -n "projects/test-conflict" | sha256sum | cut -c1-8)
SYNC_DIR="$TEST8_DIR/markdown/.mind/spaces/$SPACE_HASH"

echo "8.4. Simulating teammate changed file (git pull)..."
# Read the exported file to get the correct frontmatter structure
EXPORTED_FILE="$SYNC_DIR/conflict-test.md"
ACTUAL_ID=$(grep "^id:" "$EXPORTED_FILE" | head -1 | awk '{print $2}')
cat > "$SYNC_DIR/conflict-test.md" << EOF
---
id: $ACTUAL_ID
space: projects/test-conflict
name: conflict-test
tier: 2
pinned: false
tags:
  - cat:test
links_to: []
created_at: 2024-01-01 00:00:00
changed_at: 2024-01-15 12:00:00
---
Modified by teammate via git pull.
EOF

echo "8.5. Modifying local DB content (local change)..."
./mind edit projects/test-conflict conflict-test "Modified locally by me"

echo "8.6. Importing with db-wins strategy (default)..."
./mind sync import --space projects/test-conflict --path "$TEST8_DIR/markdown"

echo "8.7. Verifying DB content (should keep local change)..."
CONTENT=$(./mind read projects/test-conflict conflict-test 2>/dev/null) || true
if ! echo "$CONTENT" | grep -q "Modified locally by me"; then
  echo "FAIL: db-wins strategy didn't preserve local change"
  echo "Got: $CONTENT"
  rm -rf "$TEST8_DIR"
  exit 1
fi

echo "8.8. Cleanup test 8..."
./mind sync disable --space projects/test-conflict
rm -rf "$TEST8_DIR"
echo "Test 8 PASSED"

# ──────────────────────────────────────────────────────────────────
# Test 9: Git pull simulation — conflict resolution with file-wins
# ──────────────────────────────────────────────────────────────────
echo ""
echo "=== Test 9: Git pull simulation — conflict resolution with file-wins ==="

TEST9_DIR="/tmp/mind-sync-e2e-test9-$$"
TEST9_DB="$TEST9_DIR/test9.db"
mkdir -p "$TEST9_DIR"
export MIND_DB_PATH="$TEST9_DB"

echo "9.1. Creating conflict test space..."
./mind create projects/test-file-wins "File wins test space" --tags type:project

echo "9.2. Enabling sync..."
./mind sync enable --space projects/test-file-wins --path "$TEST9_DIR/markdown"

echo "9.3. Creating memory and exporting..."
./mind add projects/test-file-wins file-wins-test "Original file content" --tags cat:test
./mind sync now --space projects/test-file-wins --path "$TEST9_DIR/markdown"

SPACE_HASH=$(echo -n "projects/test-file-wins" | sha256sum | cut -c1-8)
SYNC_DIR="$TEST9_DIR/markdown/.mind/spaces/$SPACE_HASH"

echo "9.4. Modifying file externally (simulating teammate change via git pull)..."
# Read the exported file to get the correct frontmatter structure
EXPORTED_FILE="$SYNC_DIR/file-wins-test.md"
# Extract the id from the exported file and create updated file with new content
ACTUAL_ID=$(grep "^id:" "$EXPORTED_FILE" | head -1 | awk '{print $2}')
cat > "$SYNC_DIR/file-wins-test.md" << EOF
---
id: $ACTUAL_ID
space: projects/test-file-wins
name: file-wins-test
tier: 2
pinned: false
tags:
  - cat:test
links_to: []
created_at: 2024-01-01 00:00:00
changed_at: 2024-01-15 14:00:00
---
File content that should win after sync import.
EOF

echo "9.5. Modifying local DB content..."
./mind edit projects/test-file-wins file-wins-test "Local content that should lose"

echo "9.6. Setting file-wins strategy in custom path config..."
# sync conflict doesn't support --path, so we manually update the config
CONFIG_FILE="$TEST9_DIR/markdown/.mind/config.yml"
if grep -q "projects/test-file-wins:" "$CONFIG_FILE"; then
  # Update existing entry
  sed -i "s/projects\/test-file-wins:/projects\/test-file-wins:\n    conflictResolution: file-wins/" "$CONFIG_FILE" 2>/dev/null || true
  # If already has conflictResolution, replace it
  if grep -A1 "projects/test-file-wins:" "$CONFIG_FILE" | grep -q "conflictResolution"; then
    sed -i '/projects\/test-file-wins:/,/conflictResolution:/s/conflictResolution:.*/conflictResolution: file-wins/' "$CONFIG_FILE" 2>/dev/null || true
  fi
else
  # Add new entry
  echo "  projects/test-file-wins:" >> "$CONFIG_FILE"
  echo "    enabled: true" >> "$CONFIG_FILE"
  echo "    conflictResolution: file-wins" >> "$CONFIG_FILE"
fi

echo "9.7. Importing with file-wins strategy..."
./mind sync import --space projects/test-file-wins --path "$TEST9_DIR/markdown"

echo "9.8. Verifying file content won..."
CONTENT=$(./mind read projects/test-file-wins file-wins-test 2>/dev/null) || true
if ! echo "$CONTENT" | grep -q "File content that should win after sync import"; then
  echo "FAIL: file-wins strategy didn't use file content"
  echo "Got: $CONTENT"
  rm -rf "$TEST9_DIR"
  exit 1
fi

echo "9.9. Cleanup test 9..."
./mind sync disable --space projects/test-file-wins
rm -rf "$TEST9_DIR"
echo "Test 9 PASSED"

# Cleanup
echo "11. Cleanup..."
rm -rf "$TEST_DIR"

echo ""
echo "=== E2E Test PASSED ==="