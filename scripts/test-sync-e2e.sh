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

# Cleanup
echo "11. Cleanup..."
rm -rf "$TEST_DIR"

echo ""
echo "=== E2E Test PASSED ==="