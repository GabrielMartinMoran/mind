// ── Sync Export Integration Tests ──

import { existsSync, readFileSync, mkdirSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { expect, test, beforeEach, afterEach, describe } from 'bun:test';

import type { MindStore } from '../src/store/mind-store';
import { FileSyncService } from '../src/sync/file-sync-service';
import { parseFrontmatter, generateMarkdown } from '../src/sync/frontmatter';
import type { SyncSpaceConfig } from '../src/sync/types';

import { createTestStore } from './mocks/test-store';

let store: MindStore & { cleanup: () => void };
let syncService: FileSyncService;
let exportPath: string;

beforeEach(async () => {
  const result = await createTestStore();
  store = result;
  syncService = new FileSyncService(store);
  exportPath = join(tmpdir(), 'sync-test-' + Date.now() + '-' + Math.random());
  mkdirSync(exportPath, { recursive: true });
  // Create test space
  store.createSpace('projects/test', 'Test space for sync export', ['type:project']);
  store.createSpace('projects/other', 'Other test space', ['type:project']);
});

afterEach(() => {
  store.close();
  try {
    rmSync(exportPath, { recursive: true, force: true });
  } catch {
    // ignore
  }
});

describe('sync export', () => {
  test('exports memory with correct frontmatter', async () => {
    // Setup: add memory to store
    await store.addMemory('projects/test', 'test-memory', 'Test content here', {
      tags: ['cat:decision'],
      tier: 1,
    });

    // Execute: export to temp dir
    const result = await syncService.exportSpaceToFiles('projects/test', exportPath);

    // Verify: check result
    expect(result.exported).toBe(1);
    expect(result.failed).toBe(0);
    expect(result.errors).toHaveLength(0);

    // Verify: check file exists
    const filePath = join(exportPath, 'test-memory.md');
    expect(existsSync(filePath)).toBe(true);

    // Verify: parse and check frontmatter
    const fileContent = readFileSync(filePath, 'utf-8');
    const { frontmatter, content } = parseFrontmatter(fileContent);

    expect(frontmatter.name).toBe('test-memory');
    expect(frontmatter.space).toBe('projects/test');
    expect(frontmatter.tier).toBe(1);
    expect(frontmatter.pinned).toBe(false);
    expect(frontmatter.tags).toEqual(['cat:decision']);
    expect(content.trim()).toBe('Test content here');
  });

  test('exports multiple memories from a space', async () => {
    // Setup: add multiple memories
    await store.addMemory('projects/test', 'memory-one', 'Content one', {
      tags: ['cat:decision'],
      tier: 1,
    });
    await store.addMemory('projects/test', 'memory-two', 'Content two', {
      tags: ['cat:pattern'],
      tier: 2,
    });
    await store.addMemory('projects/test', 'memory-three', 'Content three', {
      tags: ['cat:bugfix'],
      tier: 2,
    });

    // Execute
    const result = await syncService.exportSpaceToFiles('projects/test', exportPath);

    // Verify
    expect(result.exported).toBe(3);
    expect(result.failed).toBe(0);

    // Verify files exist
    expect(existsSync(join(exportPath, 'memory-one.md'))).toBe(true);
    expect(existsSync(join(exportPath, 'memory-two.md'))).toBe(true);
    expect(existsSync(join(exportPath, 'memory-three.md'))).toBe(true);
  });

  test('exports memory with all frontmatter fields', async () => {
    // Setup: create memory with links
    const mem1 = await store.addMemory('projects/test', 'source-memory', 'Source content', {
      tags: ['cat:decision', 'cat:important'],
      tier: 2,
      pinned: true,
    });
    const mem2 = await store.addMemory('projects/test', 'target-memory', 'Target content', {
      tags: ['cat:pattern'],
      tier: 1,
    });
    // Create a link
    store.link(mem1.id, mem2.id, 'related');

    // Execute
    await syncService.exportSpaceToFiles('projects/test', exportPath);

    // Verify
    const filePath = join(exportPath, 'source-memory.md');
    const fileContent = readFileSync(filePath, 'utf-8');
    const { frontmatter } = parseFrontmatter(fileContent);

    expect(frontmatter.id).toBe(mem1.id);
    expect(frontmatter.space).toBe('projects/test');
    expect(frontmatter.name).toBe('source-memory');
    expect(frontmatter.tier).toBe(2);
    expect(frontmatter.pinned).toBe(true);
    expect(frontmatter.tags).toEqual(['cat:decision', 'cat:important']);
    expect(frontmatter.links_to).toContain('target-memory');
    expect(frontmatter.created_at).toBeDefined();
    expect(frontmatter.changed_at).toBeDefined();
  });

  test('exports with proper YAML array formatting for tags', async () => {
    // Setup
    await store.addMemory('projects/test', 'tagged-memory', 'Content', {
      tags: ['cat:decision', 'cat:pattern', 'cat:bugfix'],
      tier: 1,
    });

    // Execute
    await syncService.exportSpaceToFiles('projects/test', exportPath);

    // Verify: tags should be a YAML array [item1, item2, item3]
    const filePath = join(exportPath, 'tagged-memory.md');
    const fileContent = readFileSync(filePath, 'utf-8');
    const { frontmatter } = parseFrontmatter(fileContent);

    expect(Array.isArray(frontmatter.tags)).toBe(true);
    expect(frontmatter.tags).toHaveLength(3);
  });

  test('links_to contains space:name format for cross-space links', async () => {
    // Setup: create memories in different spaces
    await store.addMemory('projects/test', 'local-memory', 'Local content', {
      tags: ['cat:decision'],
      tier: 1,
    });
    await store.addMemory('projects/other', 'remote-memory', 'Remote content', {
      tags: ['cat:pattern'],
      tier: 1,
    });

    const localMem = store.getMemory('projects/test', 'local-memory')!;
    const remoteMem = store.getMemory('projects/other', 'remote-memory')!;

    // Link from local to remote
    store.link(localMem.id, remoteMem.id, 'depends_on');

    // Execute
    await syncService.exportSpaceToFiles('projects/test', exportPath);

    // Verify: links_to should contain space:name format for cross-space links
    const filePath = join(exportPath, 'local-memory.md');
    const fileContent = readFileSync(filePath, 'utf-8');
    const { frontmatter } = parseFrontmatter(fileContent);

    expect(frontmatter.links_to).toContain('projects/other:remote-memory');
  });

  test('handles empty content', async () => {
    // Setup: memory with empty content
    await store.addMemory('projects/test', 'empty-memory', '', {
      tags: ['cat:decision'],
      tier: 1,
    });

    // Execute
    const result = await syncService.exportSpaceToFiles('projects/test', exportPath);

    // Verify
    expect(result.exported).toBe(1);
    const filePath = join(exportPath, 'empty-memory.md');
    const fileContent = readFileSync(filePath, 'utf-8');
    const { frontmatter, content } = parseFrontmatter(fileContent);

    expect(frontmatter.name).toBe('empty-memory');
    expect(content.trim()).toBe('');
  });

  test('generates valid markdown that can be parsed back', async () => {
    // Setup
    await store.addMemory('projects/test', 'roundtrip-memory', 'Some content here', {
      tags: ['cat:decision'],
      tier: 1,
    });

    // Execute
    await syncService.exportSpaceToFiles('projects/test', exportPath);

    // Verify: read file and parse
    const filePath = join(exportPath, 'roundtrip-memory.md');
    const fileContent = readFileSync(filePath, 'utf-8');
    const { frontmatter, content } = parseFrontmatter(fileContent);

    // The generated file should be parseable and have expected structure
    expect(frontmatter).toBeDefined();
    expect(frontmatter.name).toBe('roundtrip-memory');
    expect(content).toBeDefined();
  });

  test('generateMarkdown produces parseable output', () => {
    // Test the frontmatter module directly
    const input = {
      id: 123,
      space: 'projects/test',
      name: 'test-memory',
      tier: 1,
      pinned: false,
      tags: ['cat:decision', 'cat:pattern'],
      links_to: ['other-memory', 'projects/other:remote'],
      created_at: '2024-01-15T10:30:00Z',
      changed_at: '2024-01-16T14:22:00Z',
    };

    const markdown = generateMarkdown(input, '**What**: test content\n**Why**: testing');
    const { frontmatter, content } = parseFrontmatter(markdown);

    expect(frontmatter.id).toBe(123);
    expect(frontmatter.space).toBe('projects/test');
    expect(frontmatter.name).toBe('test-memory');
    expect(frontmatter.tier).toBe(1);
    expect(frontmatter.pinned).toBe(false);
    expect(frontmatter.tags).toEqual(['cat:decision', 'cat:pattern']);
    expect(frontmatter.links_to).toContain('other-memory');
    expect(frontmatter.links_to).toContain('projects/other:remote');
    expect(content).toContain('**What**: test content');
  });

  test('file has no trailing whitespace anomalies', async () => {
    // Setup
    await store.addMemory('projects/test', 'ws-test', 'Content without trailing spaces', {
      tags: ['cat:decision'],
      tier: 1,
    });

    // Execute
    await syncService.exportSpaceToFiles('projects/test', exportPath);

    // Verify
    const filePath = join(exportPath, 'ws-test.md');
    const fileContent = readFileSync(filePath, 'utf-8');
    const lines = fileContent.split('\n');
    const lastLine = lines[lines.length - 1];

    // Last line should not have trailing whitespace issues
    expect(lastLine?.endsWith('   ')).toBe(false);
  });
});

describe('sync config store', () => {
  test('getSyncConfig returns null for non-existent space', () => {
    const config = store.getSyncConfig('projects/nonexistent');
    expect(config).toBeNull();
  });

  test('setSyncConfig creates new config', () => {
    const config: Partial<SyncSpaceConfig> = {
      enabled: true,
      basePath: '/tmp/sync',
      conflictResolution: 'db-wins',
    };

    store.setSyncConfig('projects/test', config);

    const saved = store.getSyncConfig('projects/test');
    expect(saved).not.toBeNull();
    expect(saved!.spaceName).toBe('projects/test');
    expect(saved!.enabled).toBe(true);
    expect(saved!.basePath).toBe('/tmp/sync');
    expect(saved!.conflictResolution).toBe('db-wins');
  });

  test('setSyncConfig updates existing config', () => {
    // Create initial config
    store.setSyncConfig('projects/test', {
      enabled: false,
      basePath: '/tmp/old',
      conflictResolution: 'db-wins',
    });

    // Update it
    store.setSyncConfig('projects/test', {
      enabled: true,
      basePath: '/tmp/new',
    });

    const saved = store.getSyncConfig('projects/test');
    expect(saved!.enabled).toBe(true);
    expect(saved!.basePath).toBe('/tmp/new');
    expect(saved!.conflictResolution).toBe('db-wins'); // unchanged
  });

  test('deleteSyncConfig removes config', () => {
    store.setSyncConfig('projects/test', { enabled: true, basePath: '/tmp' });
    store.deleteSyncConfig('projects/test');

    const config = store.getSyncConfig('projects/test');
    expect(config).toBeNull();
  });

  test('listSyncConfigs returns all configs', () => {
    store.setSyncConfig('projects/space1', { enabled: true, basePath: '/tmp/1' });
    store.setSyncConfig('projects/space2', { enabled: false, basePath: '/tmp/2' });

    const configs = store.listSyncConfigs();
    expect(configs).toHaveLength(2);
  });
});

describe('export to non-existent directory', () => {
  test('creates directory if it does not exist', async () => {
    const newPath = join(tmpdir(), 'new-sync-dir-' + Date.now());

    // Ensure it doesn't exist
    expect(existsSync(newPath)).toBe(false);

    // Execute - should create directory
    await syncService.exportSpaceToFiles('projects/test', newPath);

    // Verify directory was created
    expect(existsSync(newPath)).toBe(true);

    // Cleanup
    rmSync(newPath, { recursive: true, force: true });
  });
});
