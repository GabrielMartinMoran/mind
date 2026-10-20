import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
} from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';

import { handleRequest } from '../src/api/server';
import { executeCommand } from '../src/cli/command-executor';
import { createCheckpointTools } from '../src/mcp/tools/checkpoint';
import { createMemoryTools } from '../src/mcp/tools/memories';
import type { MindStore } from '../src/store/mind-store';
import { initMindDir, loadConfig, saveConfig } from '../src/sync/config-file';
import { parseFrontmatter } from '../src/sync/frontmatter';
import { getSpaceDir, getSpaceSyncDir, getSyncBasePath } from '../src/sync/normalize';
import type { SpaceManifestV1 } from '../src/sync/types';

import { createTestStore } from './mocks/test-store';

let store: MindStore & { cleanup: () => void };
let root: string;
let previousSyncRoot: string | undefined;

function enableSync(
  space: string,
  conflictResolution: 'db-wins' | 'file-wins' | 'latest-wins' = 'db-wins'
) {
  initMindDir(root);
  const basePath = getSyncBasePath(root);
  const config = loadConfig(basePath)!;
  config.spaces[space] = { enabled: true, conflictResolution };
  saveConfig(basePath, config);
}

function readFrontmatter(store: MindStore, space: string, fileName: string) {
  const file = readFileSync(
    join(getSpaceDir(getSyncBasePath(root), space, store), fileName),
    'utf-8'
  );
  return parseFrontmatter(file).frontmatter;
}

function readManifest(store: MindStore, space: string): SpaceManifestV1 {
  return JSON.parse(
    readFileSync(join(getSpaceDir(getSyncBasePath(root), space, store), 'manifest.json'), 'utf-8')
  ) as SpaceManifestV1;
}

beforeEach(() => {
  root = join(tmpdir(), `mind-autosync-redesign-${Date.now()}-${Math.random()}`);
  mkdirSync(root, { recursive: true });
  previousSyncRoot = process.env.MIND_SYNC_ROOT;
  process.env.MIND_SYNC_ROOT = root;
  store = createTestStore();
});

afterEach(() => {
  store.cleanup();
  if (previousSyncRoot === undefined) delete process.env.MIND_SYNC_ROOT;
  else process.env.MIND_SYNC_ROOT = previousSyncRoot;
  rmSync(root, { recursive: true, force: true });
});

describe('manifest v2 canonical hashes and timestamps', () => {
  test('normalizes UTC-naive DB timestamps and writes baseline hashes', async () => {
    const { FileSyncService } = await import('../src/sync/file-sync-service');
    store.createSpace('projects/test', 'Test', ['type:project']);
    await store.addMemory('projects/test', 'baseline-memory', 'Body', { tags: ['b', 'a'] });

    enableSync('projects/test');
    const result = await new FileSyncService(store).exportSpaceToFiles(
      'projects/test',
      getSyncBasePath(root)
    );

    expect(result.failed).toBe(0);
    const manifest = readManifest(store, 'projects/test');
    expect(manifest.version).toBe(1);
    expect(manifest.manifest_updated_at_utc).toMatch(/Z$/);
    const entries = Object.values(manifest.entries ?? {});
    const entry = entries[0]!;
    expect(entry.memory_name).toBe('baseline-memory');
    expect(entry.baseline_content_hash).toMatch(/^[a-f0-9]{64}$/);
    expect(entry.baseline_metadata_hash).toMatch(/^[a-f0-9]{64}$/);
    expect(entry.db_changed_at_utc).toMatch(/Z$/);
    expect(entry.frontmatter_changed_at_utc).toBe(entry.db_changed_at_utc);
  });

  test('does not treat mere file existence as a conflict', async () => {
    const { evaluateSyncState } = await import('../src/sync/manifest');

    const state = evaluateSyncState({
      baselineHash: null,
      dbHash: 'db',
      fileHash: 'file',
      dbExists: true,
      fileExists: true,
    });

    expect(state).toEqual({ kind: 'untracked-file' });
  });
});

describe('latest-wins UTC timestamp decisions', () => {
  test('treats near-future timestamps within tolerance as valid', async () => {
    const { classifyUtcTimestamp, shouldUpdateMemory } =
      await import('../src/sync/conflict-resolver');
    const nearFuture = new Date(Date.now() + 60_000).toISOString();

    expect(classifyUtcTimestamp(nearFuture).kind).toBe('valid');
    expect(shouldUpdateMemory('2026-05-07 10:00:00', nearFuture, 'latest-wins')).toBe(true);
  });

  test('skips far-future timestamps with a specific reason', async () => {
    const { classifyUtcTimestamp, resolveConflict } = await import('../src/sync/conflict-resolver');
    const farFuture = new Date(Date.now() + 10 * 60_000).toISOString();

    expect(classifyUtcTimestamp(farFuture).kind).toBe('far-future');
    expect(
      resolveConflict(
        {
          memoryId: '1',
          memoryName: 'future-memory',
          space: 'projects/test',
          dbMemory: {
            id: '1',
            name: 'future-memory',
            content: 'db',
            changed_at: '2026-05-07 10:00:00',
          },
          fileFrontmatter: {
            name: 'future-memory',
            tier: 2,
            pinned: false,
            tags: [],
            links_to: [],
            created_at: '2026-05-07T10:00:00Z',
            changed_at: farFuture,
          },
          fileContent: 'file',
          dbChangedAt: '2026-05-07 10:00:00',
          fileChangedAt: farFuture,
        },
        'latest-wins'
      )
    ).toEqual({ resolution: 'skip', reason: 'file timestamp is too far in the future' });
  });

  test('updates when ISO Z file timestamp is strictly newer than naive UTC DB timestamp', async () => {
    const { shouldUpdateMemory } = await import('../src/sync/conflict-resolver');

    expect(
      shouldUpdateMemory('2026-05-07 10:00:00', '2026-05-07T10:00:01.000Z', 'latest-wins')
    ).toBe(true);
  });

  test('skips when naive UTC DB timestamp is newer than older ISO file timestamp', async () => {
    const { shouldUpdateMemory } = await import('../src/sync/conflict-resolver');

    expect(
      shouldUpdateMemory('2026-05-07 10:00:01', '2026-05-07T10:00:00.000Z', 'latest-wins')
    ).toBe(false);
  });

  test.each([
    ['2026-05-07 10:00:00', '2026-05-07T10:00:00.000Z'],
    ['2026-05-07 10:00:00', '2026-05-07T12:00:00+02:00'],
    ['2026-05-07T05:00:00-05:00', '2026-05-07 10:00:00'],
  ])(
    'skips equivalent timestamps across UTC formats (%s vs %s)',
    async (dbTimestamp, fileTimestamp) => {
      const { shouldUpdateMemory } = await import('../src/sync/conflict-resolver');

      expect(shouldUpdateMemory(dbTimestamp, fileTimestamp, 'latest-wins')).toBe(false);
    }
  );

  test('normalizes positive and negative offsets before deciding file is newer', async () => {
    const { shouldUpdateMemory } = await import('../src/sync/conflict-resolver');

    expect(
      shouldUpdateMemory('2026-05-07 10:00:00', '2026-05-07T06:00:01-04:00', 'latest-wins')
    ).toBe(true);
    expect(
      shouldUpdateMemory('2026-05-07 10:00:00', '2026-05-07T11:59:59+02:00', 'latest-wins')
    ).toBe(false);
  });

  test('invalid or missing timestamps are conservative for latest-wins imports', async () => {
    const { shouldUpdateMemory } = await import('../src/sync/conflict-resolver');

    expect(shouldUpdateMemory('2026-05-07 10:00:00', 'not-a-date', 'latest-wins')).toBe(false);
    expect(shouldUpdateMemory('not-a-date', '2026-05-07T10:00:01Z', 'latest-wins')).toBe(false);
    expect(shouldUpdateMemory('', '2026-05-07T10:00:01Z', 'latest-wins')).toBe(false);
    expect(shouldUpdateMemory('2026-05-07 10:00:00', '', 'latest-wins')).toBe(false);
  });

  test('avoids lexicographic false positives from space-vs-T and timezone offset strings', async () => {
    const { shouldUpdateMemory } = await import('../src/sync/conflict-resolver');

    expect(
      shouldUpdateMemory('2026-05-07 10:00:00', '2026-05-07T09:30:00-01:00', 'latest-wins')
    ).toBe(true);
    expect(
      shouldUpdateMemory('2026-05-07T23:30:00+14:00', '2026-05-07 10:00:00', 'latest-wins')
    ).toBe(true);
    expect(
      shouldUpdateMemory('2026-05-07T10:30:00+01:00', '2026-05-07 10:00:00', 'latest-wins')
    ).toBe(true);
  });
});

describe('withAutoExport decorator', () => {
  test('exports enabled spaces after DB mutations and skips reads/access tracking', async () => {
    const { withAutoExport } = await import('../src/sync/auto-export-store');
    store.createSpace('projects/test', 'Test', ['type:project']);
    enableSync('projects/test');
    const synced = withAutoExport(store, { projectRoot: root, source: 'cli' });

    const memory = await synced.addMemory('projects/test', 'auto-memory', 'First', {
      tags: ['cat:decision'],
    });

    const filePath = join(getSpaceSyncDir(root, 'projects/test', store), 'auto-memory.md');
    expect(existsSync(filePath)).toBe(true);

    const beforeRead = readFileSync(filePath, 'utf-8');
    synced.recordAccess(memory.id);
    expect(readFileSync(filePath, 'utf-8')).toBe(beforeRead);
  });

  test('suppresses auto-export for filesystem-origin imports', async () => {
    const { withAutoExport, runWithAutoExportSuppressed } =
      await import('../src/sync/auto-export-store');
    store.createSpace('projects/test', 'Test', ['type:project']);
    enableSync('projects/test');
    const synced = withAutoExport(store, { projectRoot: root, source: 'cli' });

    await runWithAutoExportSuppressed(async () => {
      await synced.addMemory('projects/test', 'imported-memory', 'From file', {
        tags: ['cat:decision'],
      });
    });

    expect(
      existsSync(join(getSpaceSyncDir(root, 'projects/test', store), 'imported-memory.md'))
    ).toBe(false);
  });

  test('logs auto-export failures without failing primary DB mutations', async () => {
    const { withAutoExport } = await import('../src/sync/auto-export-store');
    store.createSpace('projects/test', 'Test', ['type:project']);
    enableSync('projects/test', 'file-wins');
    const synced = withAutoExport(store, { projectRoot: root, source: 'mcp' });

    await synced.addMemory('projects/test', 'conflict-memory', 'DB content', {
      tags: ['cat:decision'],
    });
    const filePath = join(getSpaceSyncDir(root, 'projects/test', store), 'conflict-memory.md');
    writeFileSync(filePath, readFileSync(filePath, 'utf-8') + '\nexternal edit');

    await synced.updateMemory(synced.getMemory('projects/test', 'conflict-memory')!.id, {
      content: 'DB update',
    });

    expect(synced.getMemory('projects/test', 'conflict-memory')!.content).toBe('DB update');
    const logs = synced.queryLogs({ operation: 'sync.auto_export', level: 'warn', limit: 5 });
    expect(logs.total).toBeGreaterThanOrEqual(1);
  });

  test('exports tier, tag, pin, and link mutations and skips recordAccess changes', async () => {
    const { withAutoExport } = await import('../src/sync/auto-export-store');
    store.createSpace('projects/test', 'Test', ['type:project']);
    enableSync('projects/test');
    const synced = withAutoExport(store, { projectRoot: root, source: 'cli' });
    const source = await synced.addMemory('projects/test', 'source', 'Source', {
      tags: ['cat:decision'],
      tier: 3,
    });
    const target = await synced.addMemory('projects/test', 'target', 'Target', {
      tags: ['cat:pattern'],
    });

    synced.promote(source.id);
    expect(readFrontmatter(store, 'projects/test', 'source.md').tier).toBe(2);

    synced.addMemoryTag(source.id, 'cat:bugfix');
    expect(readFrontmatter(store, 'projects/test', 'source.md').tags).toContain('cat:bugfix');

    synced.removeMemoryTag(source.id, 'cat:decision');
    expect(readFrontmatter(store, 'projects/test', 'source.md').tags).not.toContain('cat:decision');

    synced.setMemoryTags(source.id, ['cat:discovery']);
    expect(readFrontmatter(store, 'projects/test', 'source.md').tags).toEqual(['cat:discovery']);

    synced.pin(source.id);
    expect(readFrontmatter(store, 'projects/test', 'source.md').pinned).toBe(true);

    synced.link(source.id, target.id, 'related');
    expect(readFrontmatter(store, 'projects/test', 'source.md').links_to).toContain('target');

    synced.unlink(source.id, target.id);
    expect(readFrontmatter(store, 'projects/test', 'source.md').links_to).not.toContain('target');

    synced.unpin(source.id);
    expect(readFrontmatter(store, 'projects/test', 'source.md').pinned).toBe(false);

    const beforeAccess = readFileSync(
      join(getSpaceSyncDir(root, 'projects/test', store), 'source.md'),
      'utf-8'
    );
    synced.recordAccess(source.id);
    expect(
      readFileSync(join(getSpaceSyncDir(root, 'projects/test', store), 'source.md'), 'utf-8')
    ).toBe(beforeAccess);
  });

  test('exports checkpoint save and checkpoint done mutations through MCP tools', async () => {
    const { withAutoExport } = await import('../src/sync/auto-export-store');
    store.createSpace('projects/test', 'Test', ['type:project']);
    enableSync('projects/test');
    const synced = withAutoExport(store, { projectRoot: root, source: 'mcp' });
    const checkpoints = createCheckpointTools(synced);

    const saveResult = await checkpoints.checkpoint_save.handler({
      space: 'projects/test',
      goal: 'Autosync checkpoint coverage',
      pending: '',
      notes: 'Created by test',
      linked_memories: [],
    });
    expect(saveResult.isError).not.toBe(true);

    const checkpointName = synced.listMemories('projects/test', { tag: 'checkpoint' })[0]!.name;
    expect(
      existsSync(join(getSpaceSyncDir(root, 'projects/test', store), `${checkpointName}.md`))
    ).toBe(true);

    const doneResult = await checkpoints.checkpoint_done.handler({
      space: 'projects/test',
      checkpointName,
      summary: 'Checkpoint completed by autosync test',
    });
    expect(doneResult.isError).not.toBe(true);

    const exportedFiles = Object.values(readManifest(store, 'projects/test').entries ?? {}).map(
      entry => entry.path
    );
    expect(exportedFiles.some(path => path.startsWith('session-'))).toBe(true);
  });
});

describe('sync service conflict/stale behavior', () => {
  test('evaluates manifest drift without modifying missing managed files or DB', async () => {
    const { FileSyncService } = await import('../src/sync/file-sync-service');
    const { evaluateSyncStatus } = await import('../src/sync/status-diagnostics');
    store.createSpace('projects/test', 'Test', ['type:project']);
    await store.addMemory('projects/test', 'missing-file', 'Body', { tags: ['cat:decision'] });
    enableSync('projects/test');
    await new FileSyncService(store).exportSpaceToFiles('projects/test', getSyncBasePath(root));

    const filePath = join(getSpaceSyncDir(root, 'projects/test', store), 'missing-file.md');
    unlinkSync(filePath);
    const status = evaluateSyncStatus(store, 'projects/test', getSyncBasePath(root));

    expect(status.counts.dbMemories).toBe(1);
    expect(status.counts.manifestEntries).toBe(1);
    expect(status.counts.files).toBe(0);
    expect(status.counts.missingManagedFiles).toBe(1);
    expect(status.warnings).toContain('Missing managed file for missing-file: missing-file.md');
    expect(store.getMemory('projects/test', 'missing-file')).not.toBeNull();
  });

  test('db-wins prunes previously managed files after rename', async () => {
    const { withAutoExport } = await import('../src/sync/auto-export-store');
    store.createSpace('projects/test', 'Test', ['type:project']);
    enableSync('projects/test');
    const synced = withAutoExport(store, { projectRoot: root, source: 'cli' });

    const memory = await synced.addMemory('projects/test', 'old-name', 'Body', {
      tags: ['cat:decision'],
    });
    await synced.updateMemory(memory.id, { name: 'new-name' });

    const dir = getSpaceSyncDir(root, 'projects/test', store);
    expect(existsSync(join(dir, 'old-name.md'))).toBe(false);
    expect(existsSync(join(dir, 'new-name.md'))).toBe(true);
  });

  test('uses collision-safe filenames instead of overwriting distinct memories', async () => {
    const { FileSyncService } = await import('../src/sync/file-sync-service');
    store.createSpace('projects/test', 'Test', ['type:project']);
    await store.addMemory('projects/test', 'a/b', 'Slash', { tags: ['cat:decision'] });
    await store.addMemory('projects/test', 'a:b', 'Colon', { tags: ['cat:decision'] });
    enableSync('projects/test');

    const result = await new FileSyncService(store).exportSpaceToFiles(
      'projects/test',
      getSyncBasePath(root)
    );

    expect(result.failed).toBe(0);
    expect(result.exported).toBe(2);
    expect(
      Object.values(readManifest(store, 'projects/test').entries ?? {})
        .map(e => e.path)
        .sort()
    ).toHaveLength(2);
  });

  test('keeps a DB-origin lock long enough for watcher debounce', async () => {
    const { SyncCoordinator } = await import('../src/sync/sync-coordinator');
    store.createSpace('projects/test', 'Test', ['type:project']);
    await store.addMemory('projects/test', 'locked-memory', 'Body', { tags: ['cat:decision'] });
    enableSync('projects/test');

    const coordinator = new SyncCoordinator(store, { projectRoot: root, source: 'cli' });
    await coordinator.autoExportSpace('projects/test');

    expect(coordinator.isDbOriginLocked('projects/test')).toBe(true);
  });

  test('latest-wins auto-export proceeds when normalized DB timestamp beats older conflicting file mtime', async () => {
    const { FileSyncService } = await import('../src/sync/file-sync-service');
    store.createSpace('projects/test', 'Test', ['type:project']);
    const memory = await store.addMemory('projects/test', 'latest-db', 'Original', {
      tags: ['cat:decision'],
    });
    enableSync('projects/test', 'latest-wins');
    await new FileSyncService(store, { conflictResolution: 'latest-wins' }).exportSpaceToFiles(
      'projects/test',
      getSyncBasePath(root)
    );

    const filePath = join(getSpaceSyncDir(root, 'projects/test', store), 'latest-db.md');
    const externalFile = readFileSync(filePath, 'utf-8') + '\nexternal conflict';
    writeFileSync(filePath, externalFile);
    const olderFileMtime = new Date(Date.parse(memory.changed_at.replace(' ', 'T') + 'Z') - 60_000);
    utimesSync(filePath, olderFileMtime, olderFileMtime);
    await store.updateMemory(memory.id, { content: 'DB wins with newer timestamp' });

    const result = await new FileSyncService(store, {
      conflictResolution: 'latest-wins',
    }).exportSpaceToFiles('projects/test', getSyncBasePath(root));

    expect(result.failed).toBe(0);
    expect(readFileSync(filePath, 'utf-8')).toContain('DB wins with newer timestamp');
  });

  test('latest-wins auto-export skips when conflicting file mtime is newer than normalized DB timestamp', async () => {
    const { FileSyncService } = await import('../src/sync/file-sync-service');
    store.createSpace('projects/test', 'Test', ['type:project']);
    const memory = await store.addMemory('projects/test', 'latest-file', 'Original', {
      tags: ['cat:decision'],
    });
    enableSync('projects/test', 'latest-wins');
    await new FileSyncService(store, { conflictResolution: 'latest-wins' }).exportSpaceToFiles(
      'projects/test',
      getSyncBasePath(root)
    );

    const filePath = join(getSpaceSyncDir(root, 'projects/test', store), 'latest-file.md');
    writeFileSync(filePath, readFileSync(filePath, 'utf-8') + '\nexternal conflict');
    const newerFileMtime = new Date(Date.parse(memory.changed_at.replace(' ', 'T') + 'Z') + 60_000);
    utimesSync(filePath, newerFileMtime, newerFileMtime);
    await store.updateMemory(memory.id, { content: 'DB loses with older timestamp' });

    const result = await new FileSyncService(store, {
      conflictResolution: 'latest-wins',
    }).exportSpaceToFiles('projects/test', getSyncBasePath(root));

    expect(result.failed).toBe(1);
    expect(result.warnings?.[0]).toContain('DB export skipped');
    expect(readFileSync(filePath, 'utf-8')).toContain('external conflict');
  });
});

describe('CLI, API, and MCP mutation entrypoints', () => {
  test('CLI add writes enabled sync files automatically', async () => {
    const logs: string[] = [];
    store.createSpace('projects/test', 'Test', ['type:project']);
    enableSync('projects/test');

    await executeCommand(
      ['add', 'projects/test', 'cli-memory', 'From CLI', '--tags', 'cat:decision'],
      store,
      {
        logInfo: message => logs.push(message),
        logError: message => logs.push(message),
      }
    );

    expect(existsSync(join(getSpaceSyncDir(root, 'projects/test', store), 'cli-memory.md'))).toBe(
      true
    );
  });

  test('API memory creation writes enabled sync files automatically', async () => {
    store.createSpace('projects/test', 'Test', ['type:project']);
    enableSync('projects/test');

    const response = await handleRequest(
      new Request('http://localhost/api/spaces/projects%2Ftest/memories', {
        method: 'POST',
        body: JSON.stringify({ name: 'api-memory', content: 'From API', tags: ['cat:decision'] }),
      }),
      store
    );

    expect(response.status).toBe(201);
    expect(existsSync(join(getSpaceSyncDir(root, 'projects/test', store), 'api-memory.md'))).toBe(
      true
    );
  });

  test('MCP memory_add writes enabled sync files automatically', async () => {
    store.createSpace('projects/test', 'Test', ['type:project']);
    enableSync('projects/test');
    const tools = createMemoryTools(store);

    const result = await tools.memory_add.handler({
      space: 'projects/test',
      name: 'mcp-memory',
      content: 'From MCP',
      tags: ['cat:decision'],
    });

    expect(result.isError).not.toBe(true);
    expect(existsSync(join(getSpaceSyncDir(root, 'projects/test', store), 'mcp-memory.md'))).toBe(
      true
    );
  });
});
