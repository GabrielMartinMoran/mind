import { getAgentCapabilities, type Agent, type CapabilityMap } from '../cli/capabilities';
import { buildLinkedMemoriesArray } from '../helpers/link-building';
import { isSessionLikeMemory } from '../helpers/session-summary';
import type { MindStore } from '../store/mind-store';
import { EmptySearchQueryError } from '../store/shared/search-query-error';
import type { LinkDirection } from '../types';

export type RecoveryFormat = 'text' | 'md' | 'json';

type CheckpointContent = Record<string, unknown>;

interface RecoveryCheckpoint {
  name: string;
  space: string;
  tags: string[];
  content: CheckpointContent;
  links: Array<{
    targetSpace: string;
    targetName: string;
    label: string;
    direction: LinkDirection;
  }>;
}

export interface RecoveryPack {
  space: string;
  checkpoint: RecoveryCheckpoint | null;
  context_hits: Array<{ ref: string; tier: number; score?: number }>;
  capability_profile: CapabilityMap;
  degradation: string[];
  guidance: string[];
}

function parseCheckpointContent(raw: string): CheckpointContent {
  try {
    return JSON.parse(raw) as CheckpointContent;
  } catch {
    return { raw };
  }
}

function buildDegradation(profile: CapabilityMap): string[] {
  const lines: string[] = [];
  const entries: Array<[keyof CapabilityMap, string]> = [
    ['L1_MCP', 'L1 transport'],
    ['L2_INSTRUCTIONS', 'L2 instructions'],
    ['L3_HOOKS', 'L3 automation'],
  ];

  for (const [key, label] of entries) {
    const capability = profile[key];
    if (capability.status !== 'supported') {
      lines.push(`${label} is ${capability.status}. Fallback: ${capability.fallback}`);
    }
  }

  return lines;
}

function checkpointQuery(content: CheckpointContent): string {
  const goal = String(content.goal ?? '').trim();
  const pending = String(content.pending ?? '').trim();
  const notes = String(content.notes ?? '').trim();
  return [goal, pending, notes].filter(Boolean).join(' ');
}

async function loadSessionHistory(store: MindStore, space: string) {
  const total = await store.queryMemoriesCount({ space });
  const memories = [] as ReturnType<MindStore['queryMemories']>;

  for (let offset = 0; offset < total; offset += 500) {
    const batch = store.queryMemories({
      space,
      limit: 500,
      offset,
    });

    for (const memory of batch) {
      const fullMemory = store.getMemoryById(memory.id);
      if (fullMemory && isSessionLikeMemory(fullMemory)) {
        memories.push(memory);
      }
    }
  }

  return memories;
}

export async function buildRecoveryPack(
  store: MindStore,
  args: { space: string; includeHistory?: boolean; agent?: Agent }
): Promise<RecoveryPack> {
  const agent = args.agent ?? 'opencode';
  const capability_profile = getAgentCapabilities(agent);
  const guidance: string[] = [];
  const space = args.space;

  let checkpoint: RecoveryCheckpoint | null = null;
  const context_hits: RecoveryPack['context_hits'] = [];

  const spaceExists = store.getSpace(space);
  if (!spaceExists) {
    guidance.push(`Space "${space}" not found.`);
    guidance.push(`Use checkpoint_save with space="${space}" to start continuity.`);
  } else {
    const allCheckpoints = store.listMemories(space, { tag: 'checkpoint' });
    let candidates = allCheckpoints.filter(memory => memory.tags.includes('active'));

    // When includeHistory=true, look for same-space session summaries first.
    if (args.includeHistory) {
      const sameSpaceSessions = await loadSessionHistory(store, space);
      if (sameSpaceSessions.length > 0) {
        candidates = [...candidates, ...sameSpaceSessions];
      } else {
        const sessionSpaceName = space.startsWith('projects/')
          ? `sessions/${space.slice('projects/'.length)}`
          : `sessions/${space}`;

        if (store.getSpace(sessionSpaceName)) {
          candidates = [...candidates, ...(await loadSessionHistory(store, sessionSpaceName))];
        }
      }
    }

    candidates.sort((a, b) => new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime());
    const latest = candidates[0];

    if (!latest) {
      guidance.push('No active checkpoint found.');
      guidance.push(`Create one with checkpoint_save space="${space}".`);
    } else {
      const memory = store.getMemoryById(latest.id);
      if (memory) {
        const content = parseCheckpointContent(memory.content);
        const linkedMemories = buildLinkedMemoriesArray(store, latest.id, 5);
        checkpoint = {
          name: memory.name,
          space: memory.space_name,
          tags: memory.tags,
          content,
          links: linkedMemories.map(link => ({
            targetSpace: link.space,
            targetName: link.name,
            label: link.label,
            direction: link.direction,
          })),
        };

        // Semantic search for context, excluding checkpoint memories
        const retrievalQuery = checkpointQuery(content);
        if (retrievalQuery.length > 0) {
          try {
            const hits = await store.search(retrievalQuery, { space });
            for (const hit of hits.slice(0, 5)) {
              if (hit.tags?.includes('checkpoint')) continue;
              context_hits.push({
                ref: `${hit.space_name}:${hit.name}`,
                tier: hit.tier,
                score: hit.similarity,
              });
            }
          } catch (error) {
            // Checkpoint text made only of common words is not a search query;
            // keep the existing recent-memory fallback. Other failures surface.
            if (!(error instanceof EmptySearchQueryError)) throw error;
          }
        }
      } else {
        guidance.push('Checkpoint memory could not be loaded.');
      }
    }
  }

  if (context_hits.length === 0) {
    const recent = store.queryMemories({ space, limit: 5 });
    for (const memory of recent) {
      if (memory.tags?.includes('checkpoint')) continue;
      context_hits.push({
        ref: `${memory.space_name}:${memory.name}`,
        tier: memory.tier,
      });
    }
  }

  if (guidance.length === 0) {
    guidance.push('Use checkpoint_done when the task is finished.');
  }

  return {
    space,
    checkpoint,
    context_hits,
    capability_profile,
    degradation: buildDegradation(capability_profile),
    guidance,
  };
}

export function renderRecoveryPack(pack: RecoveryPack, format: RecoveryFormat): string {
  if (format === 'json') {
    return JSON.stringify(pack, null, 2);
  }

  const goal = String(pack.checkpoint?.content?.goal ?? 'N/A');
  const pending = String(pack.checkpoint?.content?.pending ?? 'N/A');
  const hits = pack.context_hits.map(hit => `- ${hit.ref} (T${hit.tier})`).join('\n') || '- none';
  const degradation = pack.degradation.map(line => `- ${line}`).join('\n') || '- none';
  const guidance = pack.guidance.map(line => `- ${line}`).join('\n') || '- none';

  if (format === 'md') {
    return [
      '# Recovery Pack',
      '',
      `- Space: ${pack.space}`,
      `- Checkpoint: ${pack.checkpoint ? pack.checkpoint.name : 'none'}`,
      `- Goal: ${goal}`,
      `- Pending: ${pending}`,
      '',
      '## Context hits',
      hits,
      '',
      '## Capability profile',
      `- L1: ${pack.capability_profile.L1_MCP.status}`,
      `- L2: ${pack.capability_profile.L2_INSTRUCTIONS.status}`,
      `- L3: ${pack.capability_profile.L3_HOOKS.status}`,
      '',
      '## Degradation',
      degradation,
      '',
      '## Guidance',
      guidance,
    ].join('\n');
  }

  return [
    `Recovery Pack for ${pack.space}`,
    `Active checkpoint: ${pack.checkpoint ? pack.checkpoint.name : 'none'}`,
    `Goal: ${goal}`,
    `Pending: ${pending}`,
    'Context hits:',
    hits,
    'Capability profile:',
    `- L1 ${pack.capability_profile.L1_MCP.status}`,
    `- L2 ${pack.capability_profile.L2_INSTRUCTIONS.status}`,
    `- L3 ${pack.capability_profile.L3_HOOKS.status}`,
    'Degradation:',
    degradation,
    'Guidance:',
    guidance,
  ].join('\n');
}
