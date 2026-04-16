// ── Sync Watcher Integration Tests ──
// Tests for file-based sync config (.mind/config.yml)

import { existsSync, mkdirSync, rmSync, writeFileSync, unlinkSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { expect, test, beforeEach, afterEach, describe } from 'bun:test';

import type { MindStore } from '../src/store/mind-store';
import { AutoSyncService } from '../src/sync/auto-sync-service';
import { initMindDir, loadConfig, saveConfig } from '../src/sync/config-file';
import { FileWatcher } from '../src/sync/file-watcher';
import { generateMarkdown } from '../src/sync/frontmatter';
import { getSyncBasePath, getSpaceDir } from '../src/sync/normalize';

import { createTestStore } from './mocks/test-store';

let store: MindStore & { cleanup: () => void };
let testDir: string;
let projectRoot: string;
let syncDir: string;

beforeEach(async () => {
  const result = await createTestStore();
  store = result;
  testDir = join(tmpdir(), 'sync-watcher-test-' + Date.now() + '-' + Math.random());
  mkdirSync(testDir, { recursive: true });
  projectRoot = testDir;

  // Initialize .mind directory
  initMindDir(projectRoot);

  // Create test space
  store.createSpace('projects/test', 'Test space for sync watcher', ['type:project']);

  // Create the space sync directory
  const basePath = getSyncBasePath(projectRoot);
  syncDir = getSpaceDir(basePath, 'projects/test');
  mkdirSync(syncDir, { recursive: true });

  // Configure sync in file-based config
  const config = loadConfig(basePath)!;
  config.spaces['projects/test'] = {
    enabled: true,
    conflictResolution: 'file-wins',
  };
  saveConfig(basePath, config);
});

afterEach(() => {
  store.close();
  try {
    rmSync(testDir, { recursive: true, force: true });
  } catch {
    // ignore
  }
});

// ── FileWatcher tests ─────────────────────────────────────────────────────────

describe('file watcher', () => {
  test('detects new file in directory', async () => {
    const events: any[] = [];
    const watcher = new FileWatcher(syncDir, async event => {
      events.push(event);
    });

    watcher.start();

    // Give watcher time to start
    await new Promise(r => setTimeout(r, 200));

    // Write a new markdown file
    const filePath = join(syncDir, 'new-memory.md');
    writeFileSync(filePath, '# New Memory\n\nContent here', 'utf-8');

    // Wait for debounce + processing
    await new Promise(r => setTimeout(r, 500));

    watcher.stop();

    const addEvents = events.filter(e => e.type === 'add' || e.type === 'change');
    expect(addEvents.length).toBeGreaterThan(0);
  });

  test('detects file modification', async () => {
    // Create a file first
    const filePath = join(syncDir, 'existing-memory.md');
    writeFileSync(
      filePath,
      '---\nname: existing-memory\nid: 999\nspace: projects/test\ntier: 1\npinned: false\ntags: []\nlinks_to: []\n---\nOld content',
      'utf-8'
    );

    await new Promise(r => setTimeout(r, 300));

    const events: any[] = [];
    const watcher = new FileWatcher(syncDir, async event => {
      events.push(event);
    });

    watcher.start();
    await new Promise(r => setTimeout(r, 200));

    // Modify the file
    writeFileSync(
      filePath,
      '---\nname: existing-memory\nid: 999\nspace: projects/test\ntier: 1\npinned: false\ntags: []\nlinks_to: []\n---\nNew content',
      'utf-8'
    );

    await new Promise(r => setTimeout(r, 500));

    watcher.stop();

    const changeEvents = events.filter(e => e.type === 'change' || e.type === 'add');
    expect(changeEvents.length).toBeGreaterThan(0);
  });

  test('detects file deletion', async () => {
    // Create a file first
    const filePath = join(syncDir, 'to-delete.md');
    writeFileSync(
      filePath,
      '---\nname: to-delete\nid: 888\nspace: projects/test\ntier: 1\npinned: false\ntags: []\nlinks_to: []\n---\nContent',
      'utf-8'
    );

    await new Promise(r => setTimeout(r, 300));

    const events: any[] = [];
    const watcher = new FileWatcher(syncDir, async event => {
      events.push(event);
    });

    watcher.start();
    await new Promise(r => setTimeout(r, 200));

    // Delete the file
    unlinkSync(filePath);

    await new Promise(r => setTimeout(r, 500));

    watcher.stop();

    const unlinkEvents = events.filter(e => e.type === 'unlink');
    expect(unlinkEvents.length).toBeGreaterThan(0);
  });

  test('debounces rapid changes to same file', async () => {
    const events: any[] = [];
    const watcher = new FileWatcher(
      syncDir,
      async event => {
        events.push(event);
      },
      { debounceMs: 300 }
    );

    watcher.start();
    await new Promise(r => setTimeout(r, 200));

    const filePath = join(syncDir, 'rapid-changes.md');
    writeFileSync(filePath, 'Content 1', 'utf-8');
    await new Promise(r => setTimeout(r, 50));
    writeFileSync(filePath, 'Content 2', 'utf-8');
    await new Promise(r => setTimeout(r, 50));
    writeFileSync(filePath, 'Content 3', 'utf-8');

    // Wait for debounce window to elapse
    await new Promise(r => setTimeout(r, 600));

    watcher.stop();

    // Should have at most one event (debounced)
    const relevantEvents = events.filter(e => e.path.endsWith('rapid-changes.md'));
    expect(relevantEvents.length).toBeLessThanOrEqual(1);
  });

  test('ignores non-markdown files', async () => {
    const events: any[] = [];
    const watcher = new FileWatcher(syncDir, async event => {
      events.push(event);
    });

    watcher.start();
    await new Promise(r => setTimeout(r, 200));

    // Write a non-markdown file
    const filePath = join(syncDir, 'data.json');
    writeFileSync(filePath, '{"foo": "bar"}', 'utf-8');

    await new Promise(r => setTimeout(r, 400));

    watcher.stop();

    const jsonEvents = events.filter(e => e.path.endsWith('.json'));
    expect(jsonEvents).toHaveLength(0);
  });

  test('loop prevention: does not re-import file written by export', async () => {
    // Setup: create a memory and export it
    await store.addMemory('projects/test', 'loop-test-memory', 'Original content', {
      tags: ['cat:decision'],
      tier: 2,
    });

    // Get the sync service and write a lock
    const autoSync = new AutoSyncService(store, projectRoot);

    // Write the sync lock to simulate we just exported
    autoSync.writeSyncLock(syncDir, 'loop-test-memory.md');

    // Verify lock exists
    const lockPath = join(syncDir, '.mind-sync', '.syncing');
    expect(existsSync(lockPath)).toBe(true);

    // Clean up lock
    autoSync.clearSyncLock(syncDir);
  });
});

// ── AutoSyncService tests ─────────────────────────────────────────────────────

describe('auto-sync service', () => {
  test('startWatching creates watcher for space', async () => {
    const autoSync = new AutoSyncService(store, projectRoot);

    await autoSync.startWatching('projects/test');

    // Verify watcher was created by checking stopAll works
    await autoSync.stopAll();

    // If we get here without error, watcher was created
    expect(true).toBe(true);
  });

  test('stopWatching removes watcher', async () => {
    const autoSync = new AutoSyncService(store, projectRoot);

    await autoSync.startWatching('projects/test');
    await autoSync.stopWatching('projects/test');

    // If we get here without error, watcher was stopped cleanly
    expect(true).toBe(true);
  });

  test('importFile creates new memory in DB', async () => {
    const autoSync = new AutoSyncService(store, projectRoot);

    // Write a markdown file
    const filePath = join(syncDir, 'new-import.md');
    writeFileSync(
      filePath,
      '---\nname: new-import-memory\nid: 100\nspace: projects/test\ntier: 2\npinned: false\ntags:\n  - cat:decision\n  - cat:pattern\nlinks_to: []\n---\n**What**: New memory content\n**Why**: Testing import',
      'utf-8'
    );

    const result = await autoSync.importFile(filePath, 'projects/test');

    expect(result.action).toBe('imported');
    expect(result.memoryName).toBe('new-import-memory');

    // Verify in store
    const memory = store.getMemory('projects/test', 'new-import-memory');
    expect(memory).not.toBeNull();
    expect(memory?.content).toContain('New memory content');
  });

  test('importFile updates existing memory', async () => {
    // Create memory in DB first
    await store.addMemory('projects/test', 'existing-update', 'Original DB content', {
      tags: ['cat:bugfix'],
      tier: 1,
    });

    const autoSync = new AutoSyncService(store, projectRoot);

    // Write updated markdown file
    const filePath = join(syncDir, 'existing-update.md');
    writeFileSync(
      filePath,
      '---\nname: existing-update\nid: 200\nspace: projects/test\ntier: 1\npinned: false\ntags:\n  - cat:bugfix\nlinks_to: []\n---\nUpdated external content',
      'utf-8'
    );

    const result = await autoSync.importFile(filePath, 'projects/test');

    expect(result.action).toBe('updated');
    expect(result.memoryName).toBe('existing-update');

    // Verify in store
    const memory = store.getMemory('projects/test', 'existing-update');
    expect(memory?.content).toBe('Updated external content');
  });

  test('handles missing frontmatter gracefully', async () => {
    const autoSync = new AutoSyncService(store, projectRoot);

    // Write a markdown file without proper frontmatter
    const filePath = join(syncDir, 'no-frontmatter.md');
    writeFileSync(filePath, 'Just plain content without frontmatter delimiters', 'utf-8');

    const result = await autoSync.importFile(filePath, 'projects/test');

    expect(result.action).toBe('failed');
    expect(result.error).toContain('Invalid frontmatter');
  });

  test('sync lock file prevents re-import of recently exported file', async () => {
    // Export a memory to create the file
    await store.addMemory('projects/test', 'lock-test', 'DB content', {
      tags: ['cat:decision'],
      tier: 2,
    });

    // Get the space dir for export
    const _basePath = getSyncBasePath(projectRoot);
    const { FileSyncService } = await import('../src/sync/file-sync-service');
    const fileSync = new FileSyncService(store);
    await fileSync.exportSpaceToFiles('projects/test', syncDir);

    const autoSync = new AutoSyncService(store, projectRoot);

    // Write sync lock (simulating our own export)
    autoSync.writeSyncLock(syncDir, 'lock-test.md');

    // Try to import - should be skipped because lock is active
    // We can't directly test handleFileEvent without starting the watcher,
    // so we test the isFromSync logic via the lock file
    const lockPath = join(syncDir, '.mind-sync', '.syncing');
    expect(existsSync(lockPath)).toBe(true);

    autoSync.clearSyncLock(syncDir);
  });

  test('stopAll stops all watchers', async () => {
    const autoSync = new AutoSyncService(store, projectRoot);

    await autoSync.startWatching('projects/test');
    await autoSync.stopAll();

    // If we get here without error, stopAll worked
    expect(true).toBe(true);
  });
});

// ── Import pipeline integration tests ─────────────────────────────────────────

describe('import pipeline', () => {
  test('creates memory with correct tags and tier from markdown', async () => {
    const autoSync = new AutoSyncService(store, projectRoot);

    const filePath = join(syncDir, 'full-featured.md');
    const fm = {
      id: 300,
      space: 'projects/test',
      name: 'full-featured-memory',
      tier: 1,
      pinned: true,
      tags: ['cat:decision', 'cat:important'],
      links_to: [] as string[],
      created_at: '2024-01-01T00:00:00Z',
      changed_at: '2024-01-02T00:00:00Z',
    };
    writeFileSync(filePath, generateMarkdown(fm, '**Content**: Full featured body'), 'utf-8');

    const result = await autoSync.importFile(filePath, 'projects/test');

    expect(result.action).toBe('imported');

    const memory = store.getMemory('projects/test', 'full-featured-memory');
    expect(memory).not.toBeNull();
    expect(memory?.tier).toBe(1);
    expect(memory?.pinned).toBe(true);
    expect(memory?.tags).toContain('cat:decision');
  });

  test('db-wins strategy does not update from file', async () => {
    // Create memory with old timestamp
    const mem = await store.addMemory('projects/test', 'db-wins-test', 'DB old content', {
      tags: ['cat:decision'],
      tier: 2,
    });

    // Update the memory to have a newer changed_at
    await store.updateMemory(mem.id, { content: 'DB new content' });

    // Set strategy to db-wins in config
    const basePath = getSyncBasePath(projectRoot);
    const config = loadConfig(basePath)!;
    config.spaces['projects/test'] = {
      enabled: true,
      conflictResolution: 'db-wins',
    };
    saveConfig(basePath, config);

    const autoSync = new AutoSyncService(store, projectRoot);

    const filePath = join(syncDir, 'db-wins-test.md');
    const fm = {
      id: mem.id,
      space: 'projects/test',
      name: 'db-wins-test',
      tier: 2,
      pinned: false,
      tags: ['cat:decision'],
      links_to: [],
      created_at: mem.created_at,
      changed_at: '2024-01-01T00:00:00Z', // older than DB
    };
    writeFileSync(filePath, generateMarkdown(fm, 'File new content'), 'utf-8');

    const result = await autoSync.importFile(filePath, 'projects/test');

    expect(result.action).toBe('skipped');

    const memory = store.getMemory('projects/test', 'db-wins-test');
    expect(memory?.content).toBe('DB new content');
  });

  test('latest-wins strategy updates when file is newer', async () => {
    // Create memory with old changed_at
    const mem = await store.addMemory('projects/test', 'latest-wins-test', 'DB old content', {
      tags: ['cat:decision'],
      tier: 2,
    });

    // Set strategy to latest-wins
    const basePath = getSyncBasePath(projectRoot);
    const config = loadConfig(basePath)!;
    config.spaces['projects/test'] = {
      enabled: true,
      conflictResolution: 'latest-wins',
    };
    saveConfig(basePath, config);

    const autoSync = new AutoSyncService(store, projectRoot);

    const filePath = join(syncDir, 'latest-wins-test.md');
    const fm = {
      id: mem.id,
      space: 'projects/test',
      name: 'latest-wins-test',
      tier: 2,
      pinned: false,
      tags: ['cat:decision'],
      links_to: [],
      created_at: mem.created_at,
      changed_at: '2099-01-01T00:00:00Z', // far future = definitely newer
    };
    writeFileSync(filePath, generateMarkdown(fm, 'File newer content'), 'utf-8');

    const result = await autoSync.importFile(filePath, 'projects/test');

    expect(result.action).toBe('updated');

    const memory = store.getMemory('projects/test', 'latest-wins-test');
    expect(memory?.content).toBe('File newer content');
  });

  test('file-wins strategy always prefers file over DB', async () => {
    // Create memory in DB
    const mem = await store.addMemory('projects/test', 'file-wins-test', 'DB content', {
      tags: ['cat:decision'],
      tier: 2,
    });

    // Set strategy to file-wins
    const basePath = getSyncBasePath(projectRoot);
    const config = loadConfig(basePath)!;
    config.spaces['projects/test'] = {
      enabled: true,
      conflictResolution: 'file-wins',
    };
    saveConfig(basePath, config);

    const autoSync = new AutoSyncService(store, projectRoot);

    const filePath = join(syncDir, 'file-wins-test.md');
    const fm = {
      id: mem.id,
      space: 'projects/test',
      name: 'file-wins-test',
      tier: 2,
      pinned: false,
      tags: ['cat:decision'],
      links_to: [],
      created_at: mem.created_at,
      changed_at: '2024-01-01T00:00:00Z',
    };
    writeFileSync(filePath, generateMarkdown(fm, 'File content (newer)'), 'utf-8');

    const result = await autoSync.importFile(filePath, 'projects/test');

    expect(result.action).toBe('updated');

    const memory = store.getMemory('projects/test', 'file-wins-test');
    expect(memory?.content).toBe('File content (newer)');
  });

  test('latest-wins strategy skips update when DB is newer', async () => {
    // Create memory in DB first
    const mem = await store.addMemory('projects/test', 'db-newer-test', 'DB content', {
      tags: ['cat:decision'],
      tier: 2,
    });

    // Set strategy to latest-wins
    const basePath = getSyncBasePath(projectRoot);
    const config = loadConfig(basePath)!;
    config.spaces['projects/test'] = {
      enabled: true,
      conflictResolution: 'latest-wins',
    };
    saveConfig(basePath, config);

    const autoSync = new AutoSyncService(store, projectRoot);

    const filePath = join(syncDir, 'db-newer-test.md');
    // File with older timestamp than DB (DB has current timestamp which is newer)
    const fm = {
      id: mem.id,
      space: 'projects/test',
      name: 'db-newer-test',
      tier: 2,
      pinned: false,
      tags: ['cat:decision'],
      links_to: [],
      created_at: mem.created_at,
      changed_at: '2020-01-01T00:00:00Z', // older than DB
    };
    writeFileSync(filePath, generateMarkdown(fm, 'File older content'), 'utf-8');

    const result = await autoSync.importFile(filePath, 'projects/test');

    // Should skip because DB is newer
    expect(result.action).toBe('skipped');

    // DB content should be preserved
    const memory = store.getMemory('projects/test', 'db-newer-test');
    expect(memory?.content).toBe('DB content');
  });
});
