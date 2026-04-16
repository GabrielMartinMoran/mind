// ── Sync Export Integration Tests ──

import { existsSync, readFileSync, mkdirSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { expect, test, beforeEach, afterEach, describe } from 'bun:test';

import type { MindStore } from '../src/store/mind-store';
import { initMindDir, loadConfig, saveConfig } from '../src/sync/config-file';
import { FileSyncService } from '../src/sync/file-sync-service';
import { parseFrontmatter, generateMarkdown } from '../src/sync/frontmatter';
import { getSyncBasePath, getSpaceDir } from '../src/sync/normalize';

import { createTestStore } from './mocks/test-store';

let store: MindStore & { cleanup: () => void };
let syncService: FileSyncService;
let testDir: string;
let projectRoot: string;

beforeEach(async () => {
  const result = await createTestStore();
  store = result;
  syncService = new FileSyncService(store);
  testDir = join(tmpdir(), 'sync-test-' + Date.now() + '-' + Math.random());
  mkdirSync(testDir, { recursive: true });
  projectRoot = testDir;

  // Create test spaces
  store.createSpace('projects/test', 'Test space for sync export', ['type:project']);
  store.createSpace('projects/other', 'Other test space', ['type:project']);

  // Initialize .mind directory
  initMindDir(projectRoot);
});

afterEach(() => {
  store.close();
  try {
    rmSync(testDir, { recursive: true, force: true });
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

    // Pass basePath (.mind directory), not spaceDir
    const basePath = getSyncBasePath(projectRoot);

    // Execute: export to basePath (which contains spaces/ subdir)
    const result = await syncService.exportSpaceToFiles('projects/test', basePath);

    // Verify: check result
    expect(result.exported).toBe(1);
    expect(result.failed).toBe(0);
    expect(result.errors).toHaveLength(0);

    // Verify: check file exists in the computed space dir
    const spaceDir = getSpaceDir(basePath, 'projects/test');
    const filePath = join(spaceDir, 'test-memory.md');
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

    const basePath = getSyncBasePath(projectRoot);

    // Execute
    const result = await syncService.exportSpaceToFiles('projects/test', basePath);

    // Verify
    expect(result.exported).toBe(3);
    expect(result.failed).toBe(0);

    // Verify files exist in the computed space dir
    const spaceDir = getSpaceDir(basePath, 'projects/test');
    expect(existsSync(join(spaceDir, 'memory-one.md'))).toBe(true);
    expect(existsSync(join(spaceDir, 'memory-two.md'))).toBe(true);
    expect(existsSync(join(spaceDir, 'memory-three.md'))).toBe(true);
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

    const basePath = getSyncBasePath(projectRoot);

    // Execute
    await syncService.exportSpaceToFiles('projects/test', basePath);

    // Verify
    const spaceDir = getSpaceDir(basePath, 'projects/test');
    const filePath = join(spaceDir, 'source-memory.md');
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

    const basePath = getSyncBasePath(projectRoot);

    // Execute
    await syncService.exportSpaceToFiles('projects/test', basePath);

    // Verify: tags should be a YAML array [item1, item2, item3]
    const spaceDir = getSpaceDir(basePath, 'projects/test');
    const filePath = join(spaceDir, 'tagged-memory.md');
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

    const basePath = getSyncBasePath(projectRoot);

    // Execute
    await syncService.exportSpaceToFiles('projects/test', basePath);

    // Verify: links_to should contain space:name format for cross-space links
    const spaceDir = getSpaceDir(basePath, 'projects/test');
    const filePath = join(spaceDir, 'local-memory.md');
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

    const basePath = getSyncBasePath(projectRoot);

    // Execute
    const result = await syncService.exportSpaceToFiles('projects/test', basePath);

    // Verify
    expect(result.exported).toBe(1);
    const spaceDir = getSpaceDir(basePath, 'projects/test');
    const filePath = join(spaceDir, 'empty-memory.md');
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

    const basePath = getSyncBasePath(projectRoot);

    // Execute
    await syncService.exportSpaceToFiles('projects/test', basePath);

    // Verify: read file and parse
    const spaceDir = getSpaceDir(basePath, 'projects/test');
    const filePath = join(spaceDir, 'roundtrip-memory.md');
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

    const basePath = getSyncBasePath(projectRoot);

    // Execute
    await syncService.exportSpaceToFiles('projects/test', basePath);

    // Verify
    const spaceDir = getSpaceDir(basePath, 'projects/test');
    const filePath = join(spaceDir, 'ws-test.md');
    const fileContent = readFileSync(filePath, 'utf-8');
    const lines = fileContent.split('\n');
    const lastLine = lines[lines.length - 1];

    // Last line should not have trailing whitespace issues
    expect(lastLine?.endsWith('   ')).toBe(false);
  });
});

describe('sync config file operations', () => {
  test('space config can be stored and retrieved', () => {
    const basePath = getSyncBasePath(projectRoot);
    const config = loadConfig(basePath) ?? { version: 1, spaces: {} };

    config.spaces['projects/test'] = {
      enabled: true,
      conflictResolution: 'db-wins',
    };
    saveConfig(basePath, config);

    const loaded = loadConfig(basePath);
    expect(loaded).not.toBeNull();
    expect(loaded!.spaces['projects/test']).toEqual({
      enabled: true,
      conflictResolution: 'db-wins',
    });
  });

  test('space config can be updated', () => {
    const basePath = getSyncBasePath(projectRoot);

    // Set initial config
    let config = loadConfig(basePath) ?? { version: 1, spaces: {} };
    config.spaces['projects/test'] = {
      enabled: false,
      conflictResolution: 'db-wins',
    };
    saveConfig(basePath, config);

    // Update it
    config = loadConfig(basePath)!;
    config.spaces['projects/test'] = {
      enabled: true,
      conflictResolution: 'latest-wins',
    };
    saveConfig(basePath, config);

    const loaded = loadConfig(basePath);
    expect(loaded!.spaces['projects/test']!.enabled).toBe(true);
    expect(loaded!.spaces['projects/test']!.conflictResolution).toBe('latest-wins');
  });
});

describe('export to non-existent directory', () => {
  test('creates directory if it does not exist', async () => {
    const newPath = join(tmpdir(), 'new-sync-dir-' + Date.now());

    // Ensure it doesn't exist
    expect(existsSync(newPath)).toBe(false);

    // Execute - should create directory
    const basePath = getSyncBasePath(projectRoot);
    await syncService.exportSpaceToFiles('projects/test', basePath);

    // Verify directory was created
    const spaceDir = getSpaceDir(basePath, 'projects/test');
    expect(existsSync(spaceDir)).toBe(true);

    // Cleanup
    rmSync(newPath, { recursive: true, force: true });
  });
});
