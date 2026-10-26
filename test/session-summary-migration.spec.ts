import { afterEach, beforeEach, describe, expect, test } from 'bun:test';

import { buildRecoveryPack } from '../src/checkpoint/recovery-pack';
import { migrateLegacySessionSummaries } from '../src/migration/session-summary-migration';
import type { MindStore } from '../src/store/mind-store';

import { createTestStore } from './mocks/test-store';

let store: MindStore & { cleanup: () => void };

afterEach(() => {
  store?.cleanup();
});

describe('session summary migration', () => {
  beforeEach(() => {
    store = createTestStore();
    store.createSpace('projects/mind', 'Project space', ['type:project']);
    store.createSpace('sessions/mind', 'Legacy sessions space', ['type:project']);
    store.createSpace('other-space', 'Other space', ['test']);
  });

  test('dry run reports canonical same-space migration without mutating state', async () => {
    await store.addMemory('sessions/mind', 'summary-session-42', 'Legacy automation summary', {
      tags: ['type:session', 'cat:discovery'],
    });

    const report = await migrateLegacySessionSummaries(store, {
      projectSpace: 'projects/mind',
      dryRun: true,
    });

    expect(report.dryRun).toBe(true);
    expect(report.sourceSpace).toBe('sessions/mind');
    expect(report.targetSpace).toBe('projects/mind');
    expect(report.migrated.length).toBe(1);
    expect(report.migrated[0]?.targetName.startsWith('session-')).toBe(true);

    expect(store.getMemory('sessions/mind', 'summary-session-42')).not.toBeNull();
    expect(store.queryMemories({ space: 'projects/mind', tag: 'type:session' })).toHaveLength(0);
  });

  test('migration moves legacy summaries in place, preserves links, adds provenance, and is idempotent', async () => {
    const dependency = await store.addMemory('projects/mind', 'decision-1', 'Decision', {
      tags: ['cat:decision'],
    });
    const backlink = await store.addMemory('other-space', 'bugfix-1', 'Bugfix', {
      tags: ['cat:bugfix'],
    });
    const legacy = await store.addMemory(
      'sessions/mind',
      'summary-session-99',
      'Legacy summary body',
      {
        tags: ['type:session', 'cat:discovery'],
      }
    );

    store.link(legacy.id, dependency.id, 'related');
    store.link(backlink.id, legacy.id, 'caused_by');

    const first = await migrateLegacySessionSummaries(store, {
      projectSpace: 'projects/mind',
    });

    expect(first.migrated).toHaveLength(1);
    const migratedName = first.migrated[0]!.targetName;
    const migrated = store.getMemory('projects/mind', migratedName);
    expect(migrated).not.toBeNull();
    expect(migrated!.id).toBe(legacy.id);
    expect(migrated!.tier).toBe(3);
    expect(migrated!.tags).toContain('type:session');
    expect(migrated!.tags).toContain('cat:summary');
    expect(store.getMemory('sessions/mind', 'summary-session-99')).toBeNull();

    const migratedContent = JSON.parse(migrated!.content);
    expect(migratedContent.sessionSummary.schema).toBe('mind.session-summary/v1');
    expect(migratedContent.sessionSummary.writer.id).toBe('session_summary_migration');
    expect(migratedContent.sessionSummary.provenance.migrated_from_space).toBe('sessions/mind');
    expect(migratedContent.sessionSummary.provenance.migrated_from_name).toBe('summary-session-99');
    expect(migratedContent.whatWasDone).toBe('Legacy summary body');

    const links = store.getLinks(migrated!.id);
    expect(
      links.some(link => link.source_id === migrated!.id && link.target_id === dependency.id)
    ).toBe(true);
    expect(
      links.some(link => link.source_id === backlink.id && link.target_id === migrated!.id)
    ).toBe(true);

    const second = await migrateLegacySessionSummaries(store, {
      projectSpace: 'projects/mind',
    });

    expect(second.migrated).toHaveLength(0);
    expect(second.skipped).toHaveLength(0);
    expect(store.queryMemories({ space: 'projects/mind', tag: 'type:session' })).toHaveLength(1);
  });

  test('recovery history prefers same-space session summaries before legacy sessions space', async () => {
    await store.addMemory(
      'projects/mind',
      'session-2026-04-23-10-00-00-same-space',
      'Current summary',
      {
        tags: ['cat:discovery'],
        tier: 3,
      }
    );
    await store.addMemory('sessions/mind', 'session-2026-04-23-11-00-00-legacy', 'Legacy summary', {
      tags: ['type:session', 'cat:summary'],
      tier: 3,
    });

    const pack = await buildRecoveryPack(store, {
      space: 'projects/mind',
      includeHistory: true,
    });

    expect(pack.checkpoint?.space).toBe('projects/mind');
    expect(pack.checkpoint?.name).toBe('session-2026-04-23-10-00-00-same-space');
  });

  test('migration source selection tolerates legacy session-like memories with imperfect tags', async () => {
    await store.addMemory('sessions/mind', 'session-2026-04-23-11-00-00-legacy', 'Legacy summary', {
      tags: ['cat:discovery'],
      tier: 3,
    });

    const report = await migrateLegacySessionSummaries(store, {
      projectSpace: 'projects/mind',
    });

    expect(report.migrated).toHaveLength(1);
    expect(store.getMemory('sessions/mind', 'session-2026-04-23-11-00-00-legacy')).toBeNull();
    expect(store.getMemory('projects/mind', 'session-2026-04-23-11-00-00-legacy')).not.toBeNull();
  });

  test('recovery falls back to recent memories when checkpoint context has no informative terms', async () => {
    await store.addMemory('projects/mind', 'recent-note', 'Recent durable note', {
      tags: ['cat:discovery'],
    });
    await store.addMemory(
      'projects/mind',
      'checkpoint-stopwords',
      JSON.stringify({ goal: 'the and for', pending: 'de la', notes: '' }),
      { tags: ['checkpoint', 'active'] }
    );

    const pack = await buildRecoveryPack(store, { space: 'projects/mind' });

    expect(pack.checkpoint?.name).toBe('checkpoint-stopwords');
    expect(pack.context_hits.map(hit => hit.ref)).toEqual(['projects/mind:recent-note']);
  });

  test('recovery does not swallow unrelated search errors', async () => {
    await store.addMemory(
      'projects/mind',
      'checkpoint-strict',
      JSON.stringify({ goal: 'cloudflare', pending: '', notes: '' }),
      { tags: ['checkpoint', 'active'] }
    );

    const originalSearch = store.search;
    store.search = async () => {
      throw new Error('unexpected search failure');
    };
    try {
      await expect(buildRecoveryPack(store, { space: 'projects/mind' })).rejects.toThrow(
        'unexpected search failure'
      );
    } finally {
      store.search = originalSearch;
    }
  });
});
