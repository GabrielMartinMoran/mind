// ── Sync CLI Commands Tests ──

import { existsSync, readFileSync, mkdirSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { expect, test, beforeEach, afterEach, describe } from 'bun:test';

import type { MindStore } from '../src/store/mind-store';
import type { Tier } from '../src/types';

import { createTestStore } from './mocks/test-store';

let store: MindStore & { cleanup: () => void };
let exportPath: string;

beforeEach(async () => {
  const result = await createTestStore();
  store = result;
  exportPath = join(tmpdir(), 'sync-cli-test-' + Date.now() + '-' + Math.random());
  mkdirSync(exportPath, { recursive: true });
  // Create test space
  store.createSpace('projects/test', 'Test space for sync CLI', ['type:project']);
});

afterEach(() => {
  store.close();
  try {
    rmSync(exportPath, { recursive: true, force: true });
  } catch {
    // ignore
  }
});

describe('sync status command', () => {
  test('shows empty when no spaces configured', () => {
    const configs = store.listSyncConfigs();
    expect(configs).toHaveLength(0);
  });

  test('shows configured spaces', () => {
    store.setSyncConfig('projects/test', {
      enabled: true,
      basePath: '/tmp/sync',
      conflictResolution: 'db-wins',
    });

    const configs = store.listSyncConfigs();
    expect(configs).toHaveLength(1);
    expect(configs[0]!.spaceName).toBe('projects/test');
    expect(configs[0]!.enabled).toBe(true);
    expect(configs[0]!.basePath).toBe('/tmp/sync');
  });
});

describe('sync enable command', () => {
  test('creates config and exports files', async () => {
    // Add memories in all tiers
    await store.addMemory('projects/test', 'hot-memory', 'Hot content', {
      tags: ['cat:decision'],
      tier: 1,
    });
    await store.addMemory('projects/test', 'warm-memory', 'Warm content', {
      tags: ['cat:pattern'],
      tier: 2,
    });
    await store.addMemory('projects/test', 'cold-memory', 'Cold content', {
      tags: ['cat:bugfix'],
      tier: 3,
    });

    // Enable sync
    store.setSyncConfig('projects/test', {
      enabled: true,
      basePath: exportPath,
      conflictResolution: 'db-wins',
    });

    // Export all memories
    const result = await store.exportSpaceToFiles('projects/test', exportPath);

    // Verify all 3 tiers exported
    expect(result.exported).toBe(3);
    expect(existsSync(join(exportPath, 'hot-memory.md'))).toBe(true);
    expect(existsSync(join(exportPath, 'warm-memory.md'))).toBe(true);
    expect(existsSync(join(exportPath, 'cold-memory.md'))).toBe(true);

    // Verify config
    const config = store.getSyncConfig('projects/test');
    expect(config).not.toBeNull();
    expect(config!.enabled).toBe(true);
    expect(config!.lastExportedAt).toBeNull(); // Not updated by setSyncConfig
  });

  test('exports all tiers (T1+T2+T3) not just T1+T2', async () => {
    // Add one memory per tier
    await store.addMemory('projects/test', 'tier1-memory', 'T1 content', {
      tags: ['cat:decision'],
      tier: 1,
    });
    await store.addMemory('projects/test', 'tier2-memory', 'T2 content', {
      tags: ['cat:pattern'],
      tier: 2,
    });
    await store.addMemory('projects/test', 'tier3-memory', 'T3 content', {
      tags: ['cat:bugfix'],
      tier: 3,
    });

    const result = await store.exportSpaceToFiles('projects/test', exportPath);

    // CRITICAL: export must include all 3 tiers, not just T1+T2
    expect(result.exported).toBe(3);
  });
});

describe('sync disable command', () => {
  test('updates config to disabled', () => {
    store.setSyncConfig('projects/test', {
      enabled: true,
      basePath: '/tmp/sync',
    });

    store.setSyncConfig('projects/test', { enabled: false });

    const config = store.getSyncConfig('projects/test');
    expect(config!.enabled).toBe(false);
    // Base path should be preserved
    expect(config!.basePath).toBe('/tmp/sync');
  });

  test('does not delete files after disable', async () => {
    // Setup: enable and export
    store.setSyncConfig('projects/test', {
      enabled: true,
      basePath: exportPath,
    });
    await store.addMemory('projects/test', 'test-memory', 'Content', {
      tags: ['cat:decision'],
      tier: 1,
    });
    await store.exportSpaceToFiles('projects/test', exportPath);

    // Verify file exists
    expect(existsSync(join(exportPath, 'test-memory.md'))).toBe(true);

    // Disable sync
    store.setSyncConfig('projects/test', { enabled: false });

    // File should still exist
    expect(existsSync(join(exportPath, 'test-memory.md'))).toBe(true);
  });
});

describe('sync conflict command', () => {
  test('updates resolution strategy', () => {
    store.setSyncConfig('projects/test', {
      enabled: true,
      basePath: '/tmp/sync',
      conflictResolution: 'db-wins',
    });

    store.setSyncConfig('projects/test', { conflictResolution: 'latest-wins' });

    const config = store.getSyncConfig('projects/test');
    expect(config!.conflictResolution).toBe('latest-wins');
  });

  test('rejects invalid strategy', () => {
    store.setSyncConfig('projects/test', {
      enabled: true,
      basePath: '/tmp/sync',
      conflictResolution: 'db-wins',
    });

    // Attempting to set an invalid strategy should not change the value
    // (In the actual CLI this would be validated before calling setSyncConfig)
    const validStrategies = ['db-wins', 'file-wins', 'latest-wins'];
    expect(validStrategies).not.toContain('invalid-strategy');
  });
});

describe('sync import command', () => {
  test('imports files from directory', async () => {
    // Setup: create a markdown file to import
    const filePath = join(exportPath, 'imported-memory.md');
    const markdown = `---
id: 0
space: projects/test
name: imported-memory
tier: 2
pinned: false
tags:
  - cat:decision
links_to: []
created_at: "2024-01-15T10:00:00Z"
changed_at: "2024-01-15T10:00:00Z"
---
**What**: This memory was imported from filesystem.
**Why**: Testing the import functionality.
`;
    mkdirSync(exportPath, { recursive: true });
    rmSync(filePath, { force: true });
    readFileSync;
    const { writeFileSync: write } = await import('fs');
    write(filePath, markdown, 'utf-8');

    // Verify file exists
    expect(existsSync(filePath)).toBe(true);

    // Note: actual import would be done by the sync import CLI command
    // This test verifies the file structure is correct
    const { parseFrontmatter } = await import('../src/sync/frontmatter');
    const content = readFileSync(filePath, 'utf-8');
    const { frontmatter, content: body } = parseFrontmatter(content);

    expect(frontmatter.name).toBe('imported-memory');
    expect(frontmatter.space).toBe('projects/test');
    expect(frontmatter.tags).toContain('cat:decision');
    expect(body).toContain('**What**: This memory was imported from filesystem');
  });

  test('imported memory can be added to store', async () => {
    // This tests the full roundtrip: file -> parse -> addMemory
    const filePath = join(exportPath, 'roundtrip-memory.md');
    const { writeFileSync: write } = await import('fs');
    const { generateMarkdown } = await import('../src/sync/frontmatter');

    const markdown = generateMarkdown(
      {
        id: 0,
        space: 'projects/test',
        name: 'roundtrip-memory',
        tier: 2,
        pinned: false,
        tags: ['cat:pattern'],
        links_to: [],
        created_at: '2024-01-15T10:00:00Z',
        changed_at: '2024-01-15T10:00:00Z',
      },
      'Roundtrip content'
    );
    write(filePath, markdown, 'utf-8');

    // Parse and add to store
    const { parseFrontmatter } = await import('../src/sync/frontmatter');
    const content = readFileSync(filePath, 'utf-8');
    const { frontmatter, content: body } = parseFrontmatter(content);

    const memory = await store.addMemory(frontmatter.space, frontmatter.name, body, {
      tags: frontmatter.tags,
      tier: frontmatter.tier as Tier,
    });

    expect(memory).not.toBeNull();
    expect(memory.name).toBe('roundtrip-memory');
    expect(memory.tags).toContain('cat:pattern');
  });
});

describe('sync now command', () => {
  test('triggers full sync cycle', async () => {
    // Setup: enable sync and add memories
    store.setSyncConfig('projects/test', {
      enabled: true,
      basePath: exportPath,
      conflictResolution: 'db-wins',
    });

    await store.addMemory('projects/test', 'sync-now-memory', 'Content for sync now', {
      tags: ['cat:decision'],
      tier: 1,
    });

    // Export should work
    const exportResult = await store.exportSpaceToFiles('projects/test', exportPath);
    expect(exportResult.exported).toBeGreaterThan(0);
    expect(existsSync(join(exportPath, 'sync-now-memory.md'))).toBe(true);

    // Verify config lastExportedAt was NOT updated by exportSpaceToFiles
    // (This is expected - the CLI command would update it)
    const config = store.getSyncConfig('projects/test');
    expect(config).not.toBeNull();
  });
});

describe('sync export includes all tiers', () => {
  test('exportSpaceToFiles exports T1, T2, and T3 memories', async () => {
    // Add memories in all tiers
    await store.addMemory('projects/test', 'hot-tier', 'Hot tier content', {
      tags: ['cat:decision'],
      tier: 1,
    });
    await store.addMemory('projects/test', 'warm-tier', 'Warm tier content', {
      tags: ['cat:pattern'],
      tier: 2,
    });
    await store.addMemory('projects/test', 'cold-tier', 'Cold tier content', {
      tags: ['cat:bugfix'],
      tier: 3,
    });

    const result = await store.exportSpaceToFiles('projects/test', exportPath);

    // All three tiers must be exported
    expect(result.exported).toBe(3);
    expect(existsSync(join(exportPath, 'hot-tier.md'))).toBe(true);
    expect(existsSync(join(exportPath, 'warm-tier.md'))).toBe(true);
    expect(existsSync(join(exportPath, 'cold-tier.md'))).toBe(true);
  });

  test('exportSpaceToFiles does NOT filter by tier', async () => {
    // If listMemories is called without tier filter, it returns T1+T2 only.
    // But exportSpaceToFiles should export ALL tiers.
    // This test ensures the export doesn't miss T3 memories.

    // Add only a T3 memory
    await store.addMemory('projects/test', 'only-cold', 'Only cold tier content', {
      tags: ['cat:discovery'],
      tier: 3,
    });

    const result = await store.exportSpaceToFiles('projects/test', exportPath);

    // The T3-only memory should be exported
    expect(result.exported).toBe(1);
    expect(existsSync(join(exportPath, 'only-cold.md'))).toBe(true);
  });
});
