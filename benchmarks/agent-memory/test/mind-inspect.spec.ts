// Read-only Mind database inspectors used by benchmark B assertions.
//
// The fixtures build a minimal schema 8/10-shaped database by hand so the
// inspectors can be exercised without running the Mind CLI or touching a live
// database.

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Database } from 'bun:sqlite';
import { describe, expect, test } from 'bun:test';

import {
  inspectCheckpoints,
  inspectLinks,
  inspectMemories,
  inspectSessionSummaries,
  readMemoryNames,
} from '../src/mind/inspect';

interface SeedMemory {
  readonly id: string;
  readonly name: string;
  readonly content: string;
  readonly tier: 1 | 2 | 3;
  readonly pinned: boolean;
  readonly changedAt: string;
  readonly tags: readonly string[];
}

function createDb(
  memories: readonly SeedMemory[],
  links: readonly [string, string, string][] = []
) {
  const dir = mkdtempSync(join(tmpdir(), 'bench-inspect-'));
  const path = join(dir, 'mind.db');
  const db = new Database(path);
  db.exec(`
    CREATE TABLE spaces (id TEXT PRIMARY KEY, name TEXT UNIQUE);
    CREATE TABLE memories (
      id TEXT PRIMARY KEY,
      space_id TEXT,
      name TEXT,
      content TEXT,
      tier INTEGER,
      pinned INTEGER,
      changed_at TEXT
    );
    CREATE TABLE memory_tags (memory_id TEXT, tag TEXT);
    CREATE TABLE links (
      source_id TEXT,
      target_id TEXT,
      label TEXT,
      created_at TEXT
    );
  `);
  db.query('INSERT INTO spaces (id, name) VALUES (?, ?)').run('s1', 'projects/demo');
  const insertMemory = db.query(
    'INSERT INTO memories (id, space_id, name, content, tier, pinned, changed_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
  );
  const insertTag = db.query('INSERT INTO memory_tags (memory_id, tag) VALUES (?, ?)');
  for (const memory of memories) {
    insertMemory.run(
      memory.id,
      's1',
      memory.name,
      memory.content,
      memory.tier,
      memory.pinned ? 1 : 0,
      memory.changedAt
    );
    for (const tag of memory.tags) insertTag.run(memory.id, tag);
  }
  const insertLink = db.query(
    'INSERT INTO links (source_id, target_id, label, created_at) VALUES (?, ?, ?, ?)'
  );
  for (const [source, target, label] of links) {
    insertLink.run(source, target, label, '2026-10-18T00:00:00Z');
  }
  db.close();
  return path;
}

const memories: readonly SeedMemory[] = [
  {
    id: 'm1',
    name: 'architecture-decision',
    content: 'Use Bun only',
    tier: 1,
    pinned: true,
    changedAt: '2026-10-18T10:00:00Z',
    tags: ['cat:decision', 'type:reference', 'status:living'],
  },
  {
    id: 'm2',
    name: 'checkpoint',
    content: 'current work',
    tier: 2,
    pinned: false,
    changedAt: '2026-10-18T11:00:00Z',
    tags: ['checkpoint', 'type:session'],
  },
  {
    id: 'm3',
    name: 'session-1',
    content: 'summary',
    tier: 3,
    pinned: false,
    changedAt: '2026-10-18T12:00:00Z',
    tags: ['type:session', 'cat:summary'],
  },
];

describe('inspectMemories', () => {
  test('reads name, content, tags, tier, pinned and changed_at', () => {
    const dbPath = createDb(memories);
    const rows = inspectMemories(dbPath, 'projects/demo');
    expect(rows).toHaveLength(3);
    const decision = rows.find(row => row.name === 'architecture-decision')!;
    expect(decision.content).toBe('Use Bun only');
    expect(decision.tags).toEqual(['cat:decision', 'status:living', 'type:reference']);
    expect(decision.tier).toBe(1);
    expect(decision.pinned).toBe(true);
    expect(decision.changedAt).toBe('2026-10-18T10:00:00Z');
  });

  test('keeps the existing readMemoryNames helper intact', () => {
    const dbPath = createDb(memories);
    expect(readMemoryNames(dbPath, 'projects/demo').names).toEqual([
      'architecture-decision',
      'checkpoint',
      'session-1',
    ]);
  });
});

describe('inspectLinks', () => {
  test('includes source, target, label, created_at and direction from a reference memory', () => {
    const dbPath = createDb(memories, [
      ['m1', 'm3', 'related'],
      ['m2', 'm1', 'contradicts'],
    ]);
    const outgoing = inspectLinks(dbPath, 'projects/demo', 'architecture-decision');
    expect(outgoing).toHaveLength(2);
    const toSession = outgoing.find(link => link.target === 'session-1')!;
    expect(toSession).toEqual({
      source: 'architecture-decision',
      target: 'session-1',
      label: 'related',
      direction: 'outgoing',
      createdAt: '2026-10-18T00:00:00Z',
    });
    expect(outgoing.find(link => link.source === 'checkpoint')!.direction).toBe('incoming');
  });
});

describe('session summaries and checkpoints', () => {
  test('selects by tag and reports name/tags/tier', () => {
    const dbPath = createDb(memories);
    expect(inspectCheckpoints(dbPath, 'projects/demo')).toEqual([
      { name: 'checkpoint', tags: ['checkpoint', 'type:session'], tier: 2 },
    ]);
    expect(inspectSessionSummaries(dbPath, 'projects/demo')).toEqual([
      { name: 'session-1', tags: ['cat:summary', 'type:session'], tier: 3 },
    ]);
  });
});
