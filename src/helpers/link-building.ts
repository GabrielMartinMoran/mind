// ── Link-building helpers ──

import type { LinkedMemorySummary, MindStore } from '../store/mind-store';
import type { Link, LinkDirection } from '../types';

/**
 * Enriched link format returned by checkpoint_load and memory_read.
 */
export interface EnrichedLink {
  name: string;
  space: string;
  ref: string;
  tier: number;
  tags: string[];
  pinned: boolean;
  changed_at: string;
  label: string;
  direction: LinkDirection;
}

export interface LinkEndpoint {
  id: string;
  direction: LinkDirection;
}

/**
 * Resolve the memory at the other end of a link relative to `memoryId`.
 *
 * Returns null when the link does not touch `memoryId` or would resolve to
 * `memoryId` itself.
 */
export function resolveLinkEndpoint(
  link: Pick<Link, 'source_id' | 'target_id'>,
  memoryId: string
): LinkEndpoint | null {
  const isOutgoing = link.source_id === memoryId;
  const otherId = isOutgoing ? link.target_id : link.target_id === memoryId ? link.source_id : null;

  if (!otherId || otherId === memoryId) {
    return null;
  }

  return { id: otherId, direction: isOutgoing ? 'outgoing' : 'incoming' };
}

/**
 * Result of building linked memories for checkpoint tools.
 */
export interface LinkedMemoriesResult {
  links_to: EnrichedLink[];
  linked_by: EnrichedLink[];
}

/**
 * Transform a single LinkedMemorySummary to EnrichedLink format.
 */
export function transformLinkedSummary(summary: LinkedMemorySummary): EnrichedLink {
  return {
    name: summary.name,
    space: summary.space_name,
    ref: `${summary.space_name}:${summary.name}`,
    tier: summary.tier,
    tags: summary.tags,
    pinned: summary.pinned,
    changed_at: summary.changed_at,
    label: summary.label,
    direction: summary.direction,
  };
}

/**
 * Transform linked memory summaries from getLinkedMemorySummaries() to the
 * enriched { links_to, linked_by } response format used by memory_read.
 */
export function mapLinkedSummariesToLinksFormat(summaries: {
  links_to: LinkedMemorySummary[];
  linked_by: LinkedMemorySummary[];
}): LinkedMemoriesResult {
  return {
    links_to: summaries.links_to.map(transformLinkedSummary),
    linked_by: summaries.linked_by.map(transformLinkedSummary),
  };
}

/**
 * Build an enriched linked_memories array for a checkpoint, using the store's
 * getLinks() and getMemoryById() to fetch linked memory details.
 *
 * Used by checkpoint_load (MCP) and recover (CLI) handlers.
 */
export function buildLinkedMemoriesArray(
  store: MindStore,
  memoryId: string,
  limit?: number
): EnrichedLink[] {
  const linked_memories: EnrichedLink[] = [];
  const links = store.getLinks(memoryId);

  // Consider outgoing relations first so incoming relations cannot consume the
  // optional limit before direct outgoing relations are included.
  const orderedLinks = [
    ...links.filter(link => link.source_id === memoryId),
    ...links.filter(link => link.source_id !== memoryId && link.target_id === memoryId),
  ];

  for (const link of orderedLinks) {
    const endpoint = resolveLinkEndpoint(link, memoryId);
    if (!endpoint) {
      continue;
    }

    const linkedMem = store.getMemoryById(endpoint.id);
    if (!linkedMem) {
      continue;
    }

    linked_memories.push({
      name: linkedMem.name,
      space: linkedMem.space_name,
      ref: `${linkedMem.space_name}:${linkedMem.name}`,
      tier: linkedMem.tier,
      tags: linkedMem.tags,
      pinned: linkedMem.pinned,
      changed_at: linkedMem.changed_at,
      label: link.label,
      direction: endpoint.direction,
    });
  }

  return typeof limit === 'number' ? linked_memories.slice(0, limit) : linked_memories;
}
