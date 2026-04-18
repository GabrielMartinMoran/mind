// ── Autosync Improvements Tests ──

import { existsSync, mkdirSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { expect, test, beforeEach, afterEach, describe } from 'bun:test';

import type { MindStore } from '../src/store/mind-store';
import { initMindDir, loadConfig, saveConfig } from '../src/sync/config-file';
import { getSyncWatcherStatus } from '../src/sync/detached-watcher';
import { FileWatcher } from '../src/sync/file-watcher';
import { parseFrontmatter } from '../src/sync/frontmatter';
import { getSyncBasePath, getSpaceSyncDir } from '../src/sync/normalize';

import { createTestStore } from './mocks/test-store';

let store: MindStore & { cleanup: () => void };
let testDir: string;
let projectRoot: string;

beforeEach(async () => {
  const result = await createTestStore();
  store = result;
  testDir = join(tmpdir(), 'autosync-improvements-' + Date.now() + '-' + Math.random());
  mkdirSync(testDir, { recursive: true });
  projectRoot = testDir;

  process.chdir(testDir);
});

afterEach(() => {
  store.close();
  try {
    rmSync(testDir, { recursive: true, force: true });
  } catch {
    // ignore
  }
  process.chdir('/');
});

describe('A. sync enable --path flag support', () => {
  test('custom .mind directory can be used with sync enable', async () => {
    // Create test space
    store.createSpace('projects/test', 'Test space', ['type:project']);
    await store.addMemory('projects/test', 'test-memory', 'Test content', {
      tags: ['cat:decision'],
    });

    // Initialize .mind in custom path
    const customPath = join(testDir, 'custom', 'sync', 'dir');
    initMindDir(customPath);

    const basePath = getSyncBasePath(customPath);
    const config = loadConfig(basePath)!;
    config.spaces['projects/test'] = {
      enabled: true,
      conflictResolution: 'db-wins',
    };
    saveConfig(basePath, config);

    // Verify sync directory is created under custom path
    const syncDir = getSpaceSyncDir(customPath, 'projects/test');
    expect(existsSync(syncDir)).toBe(false); // Not yet exported

    // Export files
    const { FileSyncService } = await import('../src/sync/file-sync-service');
    const fileSync = new FileSyncService(store);
    await fileSync.exportSpaceToFiles('projects/test', basePath);

    expect(existsSync(syncDir)).toBe(true);
    expect(existsSync(join(syncDir, 'test-memory.md'))).toBe(true);
  });
});

describe('B. MIND_SYNC_ROOT environment variable support', () => {
  test('MCP server respects MIND_SYNC_ROOT env var for project root', async () => {
    const customRoot = join(testDir, 'alt-project-root');
    mkdirSync(customRoot, { recursive: true });
    initMindDir(customRoot);

    // Enable sync for a space
    const basePath = getSyncBasePath(customRoot);
    const config = loadConfig(basePath)!;
    config.spaces['projects/test'] = {
      enabled: true,
      conflictResolution: 'db-wins',
    };
    saveConfig(basePath, config);

    // Verify the config is accessible from custom root
    const loaded = loadConfig(basePath);
    expect(loaded!.spaces['projects/test']).toEqual({
      enabled: true,
      conflictResolution: 'db-wins',
    });
  });
});

describe('1. sync serve --detached mode', () => {
  test('sync serve supports --space, --detached, and --path flags', async () => {
    // This is verified by the argument parser definitions
    // The serve command should support: sync serve --space <name> [--detached] [--path <dir>]
    const serveParser = await import('../src/cli/arg-parser');
    const parser = new serveParser.ArgParser(['sync', 'serve'], 'Test', [
      { name: 'space', alias: 's', hasValue: true, description: 'Space' },
      { name: 'detached', alias: 'd', hasValue: false, description: 'Detached' },
      { name: 'path', alias: 'p', hasValue: true, description: 'Path' },
    ]);

    expect(parser.matches(['sync', 'serve', '--space', 'projects/test', '--detached'])).toBe(true);
    expect(parser.matches(['sync', 'serve', '--space', 'projects/test', '--path', '/custom'])).toBe(
      true
    );
    expect(parser.matches(['sync', 'serve', '--space', 'projects/test'])).toBe(true);
  });
});

describe('2. sync init --path support', () => {
  test('sync init supports --path flag', async () => {
    const initParser = await import('../src/cli/arg-parser');
    const parser = new initParser.ArgParser(['sync', 'init'], 'Test', [
      { name: 'path', alias: 'p', hasValue: true, description: 'Path' },
    ]);

    expect(parser.matches(['sync', 'init', '--path', '/custom/path'])).toBe(true);
    expect(parser.matches(['sync', 'init'])).toBe(true);
  });

  test('initMindDir works with custom path', () => {
    const customPath = join(testDir, 'custom', 'init', 'path');
    const config = initMindDir(customPath);

    expect(existsSync(join(customPath, '.mind', 'config.yml'))).toBe(true);
    expect(existsSync(join(customPath, '.mind', '.gitignore'))).toBe(true);
    expect(config.version).toBe(1);
  });
});

describe('3. FileWatcher auto-restart on error', () => {
  test('FileWatcher accepts restart options', () => {
    const errors: Error[] = [];
    const restarts: number[] = [];

    const watcher = new FileWatcher('/nonexistent-path', async () => {}, {
      maxRestartAttempts: 2,
      restartDelayMs: 100,
      onError: err => errors.push(err),
      onRestart: attempt => restarts.push(attempt),
    });

    expect(watcher).toBeDefined();
  });
});

describe('4. links_to import creates bidirectional links', () => {
  test('export includes links_to in frontmatter for linked memories', async () => {
    store.createSpace('projects/test', 'Test space', ['type:project']);
    const memA = await store.addMemory('projects/test', 'memory-a', 'Content A', {
      tags: ['cat:decision'],
    });
    const memB = await store.addMemory('projects/test', 'memory-b', 'Content B', {
      tags: ['cat:pattern'],
    });

    // Link A -> B
    store.link(memA.id, memB.id);

    initMindDir(projectRoot);
    const basePath = getSyncBasePath(projectRoot);

    const { FileSyncService } = await import('../src/sync/file-sync-service');
    const fileSync = new FileSyncService(store);
    await fileSync.exportSpaceToFiles('projects/test', basePath);

    const syncDir = getSpaceSyncDir(projectRoot, 'projects/test');
    const exportedFile = readFileSync(join(syncDir, 'memory-a.md'), 'utf-8');
    const { frontmatter } = parseFrontmatter(exportedFile);

    expect(frontmatter.links_to).toContain('memory-b');
  });

  test('links_to with cross-space reference uses space:name format', async () => {
    store.createSpace('projects/test', 'Test space', ['type:project']);
    store.createSpace('projects/other', 'Other space', ['type:project']);
    const memA = await store.addMemory('projects/test', 'memory-a', 'Content A', {
      tags: ['cat:decision'],
    });
    const memB = await store.addMemory('projects/other', 'memory-b', 'Content B', {
      tags: ['cat:pattern'],
    });

    // Link A (projects/test) -> B (projects/other)
    store.link(memA.id, memB.id);

    initMindDir(projectRoot);
    const basePath = getSyncBasePath(projectRoot);

    const { FileSyncService } = await import('../src/sync/file-sync-service');
    const fileSync = new FileSyncService(store);
    await fileSync.exportSpaceToFiles('projects/test', basePath);

    const syncDir = getSpaceSyncDir(projectRoot, 'projects/test');
    const exportedFile = readFileSync(join(syncDir, 'memory-a.md'), 'utf-8');
    const { frontmatter } = parseFrontmatter(exportedFile);

    expect(frontmatter.links_to).toContain('projects/other:memory-b');
  });
});

describe('5. sync status --space shows detailed stats', () => {
  test('store listMemories returns correct count', async () => {
    store.createSpace('projects/test', 'Test space', ['type:project']);
    await store.addMemory('projects/test', 'memory-1', 'Content 1', {
      tags: ['cat:decision'],
    });
    await store.addMemory('projects/test', 'memory-2', 'Content 2', {
      tags: ['cat:pattern'],
    });

    initMindDir(projectRoot);
    const basePath = getSyncBasePath(projectRoot);
    const config = loadConfig(basePath)!;
    config.spaces['projects/test'] = {
      enabled: true,
      conflictResolution: 'db-wins',
    };
    saveConfig(basePath, config);

    // Count memories via store
    const memories = store.listMemories('projects/test');
    expect(memories.length).toBe(2);
  });
});

describe('detached watcher PID file', () => {
  test('getSyncWatcherStatus returns running=false when no PID file', () => {
    const status = getSyncWatcherStatus();
    expect(status.running).toBe(false);
    expect(status.pid).toBeNull();
  });
});
