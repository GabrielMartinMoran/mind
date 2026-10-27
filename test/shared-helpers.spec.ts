import { describe, expect, test } from 'bun:test';

import { buildCheckpointContent, fetchCheckpointContent } from '../src/helpers/checkpoint-content';
import {
  buildLinkedMemoriesArray,
  mapLinkedSummariesToLinksFormat,
  resolveLinkEndpoint,
  transformLinkedSummary,
} from '../src/helpers/link-building';
import type { LinkedMemorySummary, MindStore } from '../src/store/mind-store';
import type { Memory, Tier } from '../src/types';

// ── Mock store factory ──────────────────────────────────────────────────────

function createMockStore(
  links: { source_id: string; target_id: string; label?: string }[],
  memories: Map<string, Memory>
): MindStore {
  return {
    getLinks: (id: string) => links.filter(l => l.source_id === id || l.target_id === id),
    getMemoryById: (id: string) => memories.get(id) ?? null,
    getLinkedMemorySummaries: () => ({ links_to: [], linked_by: [] }),
    // Other methods unused by helpers under test
  } as unknown as MindStore;
}

// ── link-building tests ───────────────────────────────────────────────────

describe('link-building helpers', () => {
  describe('transformLinkedSummary', () => {
    test('transforms LinkedMemorySummary to EnrichedLink', () => {
      const summary: LinkedMemorySummary = {
        id: 'summary-1',
        name: 'my-memory',
        space_name: 'projects/mind',
        tier: 2,
        tags: ['cat:decision'],
        pinned: false,
        changed_at: '2026-01-01 12:00:00',
        label: 'caused_by',
        direction: 'outgoing',
      };

      const result = transformLinkedSummary(summary);

      expect(result).toEqual({
        name: 'my-memory',
        space: 'projects/mind',
        ref: 'projects/mind:my-memory',
        tier: 2,
        tags: ['cat:decision'],
        pinned: false,
        changed_at: '2026-01-01 12:00:00',
        label: 'caused_by',
        direction: 'outgoing',
      });
    });
  });

  describe('mapLinkedSummariesToLinksFormat', () => {
    test('transforms getLinkedMemorySummaries output to enriched format', () => {
      const summaries: { links_to: LinkedMemorySummary[]; linked_by: LinkedMemorySummary[] } = {
        links_to: [
          {
            id: 'summary-a',
            name: 'memory-a',
            space_name: 'projects/mind',
            tier: 1 as Tier,
            tags: ['cat:decision'],
            pinned: true,
            changed_at: '2026-01-01 10:00:00',
            label: 'implements',
            direction: 'outgoing',
          },
        ],
        linked_by: [
          {
            id: 'summary-b',
            name: 'memory-b',
            space_name: 'projects/mind',
            tier: 2 as Tier,
            tags: ['cat:bugfix'],
            pinned: false,
            changed_at: '2026-01-02 10:00:00',
            label: 'contradicts',
            direction: 'incoming',
          },
        ],
      };

      const result = mapLinkedSummariesToLinksFormat(summaries);

      expect(result.links_to).toHaveLength(1);
      expect(result.links_to[0]).toEqual({
        name: 'memory-a',
        space: 'projects/mind',
        ref: 'projects/mind:memory-a',
        tier: 1,
        tags: ['cat:decision'],
        pinned: true,
        changed_at: '2026-01-01 10:00:00',
        label: 'implements',
        direction: 'outgoing',
      });

      expect(result.linked_by).toHaveLength(1);
      expect(result.linked_by[0]).toEqual({
        name: 'memory-b',
        space: 'projects/mind',
        ref: 'projects/mind:memory-b',
        tier: 2,
        tags: ['cat:bugfix'],
        pinned: false,
        changed_at: '2026-01-02 10:00:00',
        label: 'contradicts',
        direction: 'incoming',
      });
    });

    test('handles empty arrays', () => {
      const summaries = { links_to: [], linked_by: [] };
      const result = mapLinkedSummariesToLinksFormat(summaries);
      expect(result.links_to).toHaveLength(0);
      expect(result.linked_by).toHaveLength(0);
    });
  });

  describe('buildLinkedMemoriesArray', () => {
    test('builds enriched linked_memories array from store', () => {
      const linkedMem: Memory = {
        id: 'memory-42',
        space_name: 'projects/mind',
        space_id: 'test-space-uuid',
        name: 'linked-memory',
        content: 'some content',
        tier: 2,
        pinned: false,
        access_count: 5,
        last_accessed_at: '2026-01-01',
        embedding: null,
        tags: ['cat:pattern'],
        created_at: '2026-01-01',
        updated_at: '2026-01-01',
        changed_at: '2026-03-15 14:30:00',
      };

      const links = [{ source_id: '10', target_id: 'memory-42', label: 'related' }];
      const memories = new Map<string, Memory>([['memory-42', linkedMem]]);
      const store = createMockStore(links, memories);

      const result = buildLinkedMemoriesArray(store, '10', 5);

      expect(result).toHaveLength(1);
      expect(result[0]).toEqual({
        name: 'linked-memory',
        space: 'projects/mind',
        ref: 'projects/mind:linked-memory',
        tier: 2,
        tags: ['cat:pattern'],
        pinned: false,
        changed_at: '2026-03-15 14:30:00',
        label: 'related',
        direction: 'outgoing',
      });
    });

    test('resolves incoming links to the source memory', () => {
      const sourceMem: Memory = {
        id: 'source-1',
        space_name: 'projects/mind',
        space_id: 'test-space-uuid',
        name: 'source-memory',
        content: 'source content',
        tier: 2,
        pinned: false,
        access_count: 0,
        last_accessed_at: null,
        embedding: null,
        tags: ['cat:decision'],
        created_at: '2026-01-01',
        updated_at: '2026-01-01',
        changed_at: '2026-03-15 14:30:00',
      };

      const links = [{ source_id: 'source-1', target_id: '10', label: 'caused_by' }];
      const memories = new Map<string, Memory>([['source-1', sourceMem]]);
      const store = createMockStore(links, memories);

      const result = buildLinkedMemoriesArray(store, '10');

      expect(result).toHaveLength(1);
      expect(result[0]?.name).toBe('source-memory');
      expect(result[0]?.direction).toBe('incoming');
      expect(result[0]?.label).toBe('caused_by');
    });

    test('resolveLinkEndpoint handles outgoing, incoming, self, and unknown links', () => {
      expect(resolveLinkEndpoint({ source_id: 'a', target_id: 'b' }, 'a')).toEqual({
        id: 'b',
        direction: 'outgoing',
      });
      expect(resolveLinkEndpoint({ source_id: 'a', target_id: 'b' }, 'b')).toEqual({
        id: 'a',
        direction: 'incoming',
      });
      expect(resolveLinkEndpoint({ source_id: 'a', target_id: 'a' }, 'a')).toBeNull();
      expect(resolveLinkEndpoint({ source_id: 'a', target_id: 'b' }, 'c')).toBeNull();
    });

    test('respects limit parameter', () => {
      const memories = new Map<string, Memory>();
      const links = [
        { source_id: '1', target_id: 'mem-id-2' },
        { source_id: '1', target_id: 'mem-id-3' },
        { source_id: '1', target_id: 'mem-id-4' },
        { source_id: '1', target_id: 'mem-id-5' },
        { source_id: '1', target_id: 'mem-id-6' },
        { source_id: '1', target_id: 'mem-id-7' },
      ];

      for (let i = 2; i <= 7; i++) {
        memories.set(`mem-id-${i}`, {
          id: `mem-id-${i}`,
          space_name: 'test',
          space_id: 'test-space-uuid',
          name: `mem-${i}`,
          content: '',
          tier: 1,
          pinned: false,
          access_count: 0,
          last_accessed_at: null,
          embedding: null,
          tags: [],
          created_at: '2026-01-01',
          updated_at: '2026-01-01',
          changed_at: '2026-01-01',
        });
      }

      const store = createMockStore(links, memories);
      const result = buildLinkedMemoriesArray(store, '1', 3);

      expect(result).toHaveLength(3);
    });

    test('skips links with no corresponding memory', () => {
      const links = [{ source_id: '1', target_id: 'mem-id-999' }];
      const memories = new Map<string, Memory>();
      const store = createMockStore(links, memories);

      const result = buildLinkedMemoriesArray(store, '1', 5);
      expect(result).toHaveLength(0);
    });
  });
});

// ── checkpoint-content tests ───────────────────────────────────────────────

describe('checkpoint-content helpers', () => {
  describe('buildCheckpointContent', () => {
    test('creates JSON string with all required fields', () => {
      const result = buildCheckpointContent(
        'Implement feature X',
        'Write tests, update docs',
        'Note about something'
      );

      const parsed = JSON.parse(result);
      expect(parsed.goal).toBe('Implement feature X');
      expect(parsed.pending).toBe('Write tests, update docs');
      expect(parsed.notes).toBe('Note about something');
      expect(parsed.createdAt).toBeDefined();
      expect(parsed.updatedAt).toBeDefined();
    });

    test('handles undefined notes', () => {
      const result = buildCheckpointContent('Goal only', 'Pending only');
      const parsed = JSON.parse(result);
      expect(parsed.notes).toBe('');
    });

    test('handles null/undefined values gracefully', () => {
      const result = buildCheckpointContent(
        undefined as unknown as string,
        undefined as unknown as string,
        undefined
      );
      const parsed = JSON.parse(result);
      expect(parsed.goal).toBe('');
      expect(parsed.pending).toBe('');
      expect(parsed.notes).toBe('');
    });

    test('uses provided createdAt and updatedAt when given', () => {
      const result = buildCheckpointContent(
        'Goal',
        'Pending',
        undefined,
        '2026-01-01 10:00:00',
        '2026-01-02 15:30:00'
      );
      const parsed = JSON.parse(result);
      expect(parsed.createdAt).toBe('2026-01-01 10:00:00');
      expect(parsed.updatedAt).toBe('2026-01-02 15:30:00');
    });
  });

  describe('fetchCheckpointContent', () => {
    test('parses valid checkpoint JSON content', () => {
      const memory: Memory = {
        id: 'mem-1',
        space_name: 'test',
        space_id: 'test-space-uuid',
        name: 'checkpoint-2026-01-01',
        content: JSON.stringify({
          goal: 'Finish implementation',
          pending: 'Write tests',
          notes: 'Important note',
          createdAt: '2026-01-01 10:00:00',
          updatedAt: '2026-01-02 12:00:00',
        }),
        tier: 1,
        pinned: true,
        access_count: 0,
        last_accessed_at: null,
        embedding: null,
        tags: ['checkpoint'],
        created_at: '2026-01-01',
        updated_at: '2026-01-02',
        changed_at: '2026-01-02',
      };

      const result = fetchCheckpointContent(memory);

      expect(result).not.toBeNull();
      expect(result!.goal).toBe('Finish implementation');
      expect(result!.pending).toBe('Write tests');
      expect(result!.notes).toBe('Important note');
      expect(result!.createdAt).toBe('2026-01-01 10:00:00');
      expect(result!.updatedAt).toBe('2026-01-02 12:00:00');
    });

    test('returns null on JSON parse error', () => {
      const memory: Memory = {
        id: 'mem-1',
        space_name: 'test',
        space_id: 'test-space-uuid',
        name: 'bad-checkpoint',
        content: 'not valid json {{{',
        tier: 1,
        pinned: false,
        access_count: 0,
        last_accessed_at: null,
        embedding: null,
        tags: ['checkpoint'],
        created_at: '2026-01-01',
        updated_at: '2026-01-01',
        changed_at: '2026-01-01',
      };

      const result = fetchCheckpointContent(memory);
      expect(result).toBeNull();
    });

    test('handles missing fields in JSON with defaults', () => {
      const memory: Memory = {
        id: 'mem-1',
        space_name: 'test',
        space_id: 'test-space-uuid',
        name: 'checkpoint-minimal',
        content: JSON.stringify({ goal: 'Only goal' }),
        tier: 1,
        pinned: false,
        access_count: 0,
        last_accessed_at: null,
        embedding: null,
        tags: ['checkpoint'],
        created_at: '2026-01-01',
        updated_at: '2026-01-01',
        changed_at: '2026-01-01',
      };

      const result = fetchCheckpointContent(memory);

      expect(result).not.toBeNull();
      expect(result!.goal).toBe('Only goal');
      expect(result!.pending).toBe('');
      expect(result!.notes).toBe('');
      expect(result!.createdAt).toBeUndefined();
      expect(result!.updatedAt).toBeUndefined();
    });
  });
});
