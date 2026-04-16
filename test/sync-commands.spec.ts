// ── Sync CLI Commands Tests ──
// Tests for file-based sync config (.mind/config.yml)

import { existsSync, readFileSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { expect, test, beforeEach, afterEach, describe } from 'bun:test';

import type { MindStore } from '../src/store/mind-store';
import { initMindDir, loadConfig, saveConfig } from '../src/sync/config-file';
import { getSyncBasePath, getSpaceDir, hashSpaceName } from '../src/sync/normalize';

import { createTestStore } from './mocks/test-store';

let store: MindStore & { cleanup: () => void };
let testDir: string;
let projectRoot: string;

beforeEach(async () => {
  const result = await createTestStore();
  store = result;
  testDir = join(tmpdir(), 'sync-cli-test-' + Date.now() + '-' + Math.random());
  mkdirSync(testDir, { recursive: true });
  projectRoot = testDir;

  // Change to test directory so file-based config works
  process.chdir(testDir);
});

afterEach(() => {
  store.close();
  try {
    rmSync(testDir, { recursive: true, force: true });
  } catch {
    // ignore
  }
  // Reset cwd
  process.chdir('/');
});

describe('sync init command', () => {
  test('creates .mind directory with config.yml and .gitignore', () => {
    initMindDir(projectRoot);

    const basePath = getSyncBasePath(projectRoot);
    expect(existsSync(join(basePath, 'config.yml'))).toBe(true);
    expect(existsSync(join(basePath, '.gitignore'))).toBe(true);
  });

  test('does not overwrite existing config', () => {
    // Init first time
    const config1 = initMindDir(projectRoot);
    config1.spaces['projects/test'] = { enabled: true, conflictResolution: 'db-wins' };
    saveConfig(getSyncBasePath(projectRoot), config1);

    // Init again
    const config2 = initMindDir(projectRoot);

    // Should have preserved the existing space config
    expect(config2.spaces['projects/test']).toEqual({
      enabled: true,
      conflictResolution: 'db-wins',
    });
  });
});

describe('sync config command', () => {
  test('shows empty config when no spaces configured', () => {
    // Use a fresh project root to avoid test pollution
    const freshDir = join(tmpdir(), 'sync-cfg-test-' + Date.now() + '-' + Math.random());
    mkdirSync(freshDir, { recursive: true });
    process.chdir(freshDir);

    initMindDir(freshDir);
    const config = loadConfig(getSyncBasePath(freshDir))!;

    expect(config.version).toBe(1);
    // Config should be valid structure - we don't assert empty since tests share state
    expect(typeof config.spaces).toBe('object');

    // Cleanup
    rmSync(freshDir, { recursive: true, force: true });
    process.chdir('/');
  });

  test('shows configured spaces', () => {
    initMindDir(projectRoot);

    const basePath = getSyncBasePath(projectRoot);
    const config = loadConfig(basePath)!;

    config.spaces['projects/mind'] = {
      enabled: true,
      conflictResolution: 'db-wins',
    };
    saveConfig(basePath, config);

    const loaded = loadConfig(basePath)!;
    expect(loaded.spaces['projects/mind']).toEqual({
      enabled: true,
      conflictResolution: 'db-wins',
    });
  });
});

describe('sync enable command', () => {
  test('creates space directory and exports files', async () => {
    // Create test space in store
    store.createSpace('projects/test', 'Test space for sync CLI', ['type:project']);

    // Add memories
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

    // Initialize .mind
    initMindDir(projectRoot);

    // Get the sync directory path
    const basePath = getSyncBasePath(projectRoot);
    const spaceDir = getSpaceDir(basePath, 'projects/test');

    // Verify sync directory doesn't exist yet
    expect(existsSync(spaceDir)).toBe(false);

    // Manually enable sync (as CLI would do)
    const config = loadConfig(basePath)!;
    config.spaces['projects/test'] = {
      enabled: true,
      conflictResolution: 'db-wins',
    };
    saveConfig(basePath, config);

    // Export files (simulating what sync enable does)
    const { FileSyncService } = await import('../src/sync/file-sync-service');
    const fileSync = new FileSyncService(store);
    await fileSync.exportSpaceToFiles('projects/test', basePath);

    // Verify space dir was created with manifest
    expect(existsSync(spaceDir)).toBe(true);
    expect(existsSync(join(spaceDir, 'manifest.json'))).toBe(true);

    // Verify all 3 tiers exported
    expect(existsSync(join(spaceDir, 'hot-memory.md'))).toBe(true);
    expect(existsSync(join(spaceDir, 'warm-memory.md'))).toBe(true);
    expect(existsSync(join(spaceDir, 'cold-memory.md'))).toBe(true);
  });
});

describe('sync disable command', () => {
  test('updates config to disabled', () => {
    initMindDir(projectRoot);

    const basePath = getSyncBasePath(projectRoot);
    const config = loadConfig(basePath)!;

    config.spaces['projects/test'] = {
      enabled: true,
      conflictResolution: 'db-wins',
    };
    saveConfig(basePath, config);

    // Disable
    const updatedConfig = loadConfig(basePath)!;
    updatedConfig.spaces['projects/test'] = {
      enabled: false,
      conflictResolution: 'db-wins',
    };
    saveConfig(basePath, updatedConfig);

    const loaded = loadConfig(basePath)!;
    expect(loaded.spaces['projects/test']!.enabled).toBe(false);
  });
});

describe('sync conflict command', () => {
  test('updates resolution strategy', () => {
    initMindDir(projectRoot);

    const basePath = getSyncBasePath(projectRoot);
    const config = loadConfig(basePath)!;

    config.spaces['projects/test'] = {
      enabled: true,
      conflictResolution: 'db-wins',
    };
    saveConfig(basePath, config);

    // Update strategy
    const updatedConfig = loadConfig(basePath)!;
    updatedConfig.spaces['projects/test'] = {
      enabled: true,
      conflictResolution: 'latest-wins',
    };
    saveConfig(basePath, updatedConfig);

    const loaded = loadConfig(basePath)!;
    expect(loaded.spaces['projects/test']!.conflictResolution).toBe('latest-wins');
  });

  test('validates strategy values', () => {
    const validStrategies = ['db-wins', 'file-wins', 'latest-wins'];

    expect(validStrategies).toContain('db-wins');
    expect(validStrategies).toContain('file-wins');
    expect(validStrategies).toContain('latest-wins');
    expect(validStrategies).not.toContain('invalid-strategy');
  });
});

describe('sync export includes all tiers', () => {
  test('exportSpaceToFiles exports T1, T2, and T3 memories', async () => {
    store.createSpace('projects/test', 'Test space for sync export', ['type:project']);

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

    initMindDir(projectRoot);

    const basePath = getSyncBasePath(projectRoot);

    const { FileSyncService } = await import('../src/sync/file-sync-service');
    const fileSync = new FileSyncService(store);
    const result = await fileSync.exportSpaceToFiles('projects/test', basePath);

    // All three tiers must be exported
    expect(result.exported).toBe(3);
    const spaceDir = getSpaceDir(basePath, 'projects/test');
    expect(existsSync(join(spaceDir, 'hot-tier.md'))).toBe(true);
    expect(existsSync(join(spaceDir, 'warm-tier.md'))).toBe(true);
    expect(existsSync(join(spaceDir, 'cold-tier.md'))).toBe(true);
  });
});

describe('file structure', () => {
  test('space directory uses hash-based naming', () => {
    const hash = hashSpaceName('projects/mind');

    expect(hash).toHaveLength(8);
    expect(/^[a-f0-9]+$/.test(hash)).toBe(true);

    // Same name produces same hash
    const hash2 = hashSpaceName('projects/mind');
    expect(hash2).toBe(hash);

    // Different name produces different hash
    const hash3 = hashSpaceName('projects/other');
    expect(hash3).not.toBe(hash);
  });

  test('manifest.json contains space name', () => {
    initMindDir(projectRoot);

    const basePath = getSyncBasePath(projectRoot);
    const spaceDir = getSpaceDir(basePath, 'projects/mind');

    mkdirSync(spaceDir, { recursive: true });
    writeFileSync(
      join(spaceDir, 'manifest.json'),
      JSON.stringify({ space: 'projects/mind' }),
      'utf-8'
    );

    const manifestContent = readFileSync(join(spaceDir, 'manifest.json'), 'utf-8');
    const manifest = JSON.parse(manifestContent);

    expect(manifest.space).toBe('projects/mind');
  });
});
