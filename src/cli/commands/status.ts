import { CONFIG, TIER_LIMITS } from '../../config';
import { describeEmbeddingStatus } from '../../helpers/embedding-providers';
import { formatBytes } from '../../helpers/format';
import type { Logger } from '../../helpers/logger';
import { style } from '../../helpers/style';
import type { MindStore } from '../../store/mind-store';
import { ArgParser } from '../arg-parser';

import type { CommandGroup } from './types';

const p = ArgParser.param.bind(ArgParser);

const STATUS = new ArgParser(['status'], 'Shows storage info and per-tier breakdown');
const STATUS_SPACE = new ArgParser(
  ['status', p('space')],
  'Shows tier breakdown for a specific space'
);

function renderStatus(store: MindStore, logger: Logger, space?: string): void {
  const status = store.getStatus(space);

  if (space) {
    logger.logInfo(style(`🧠 Status: ${space}`, ['bold', 'magenta']));
  } else {
    logger.logInfo(style('🧠 Mind Status', ['bold', 'magenta']));
    logger.logInfo('');
    logger.logInfo(
      `   Storage:   ${style(status.db_path, ['dim'])} (${formatBytes(status.db_size_bytes)})`
    );
    logger.logInfo(`   Spaces:    ${status.total_spaces}`);
    logger.logInfo(`   Memories:  ${status.total_memories} total`);
  }

  logger.logInfo('');
  logger.logInfo('   Tier           Count  Pinned  Limit');
  logger.logInfo('   ─────────────────────────────────────');

  const tierRows: { icon: string; label: string; limit: string; tier: 1 | 2 | 3 }[] = [
    { tier: 1, icon: '🔴', label: 'T1 hot    ', limit: `${TIER_LIMITS[1]}/space` },
    { tier: 2, icon: '🟡', label: 'T2 warm   ', limit: `${TIER_LIMITS[2]}/space` },
    { tier: 3, icon: '🔵', label: 'T3 cold   ', limit: 'unlimited' },
  ];

  for (const row of tierRows) {
    const data = status.by_tier.find(b => b.tier === row.tier)!;
    const count = String(data.count).padStart(5);
    const pinned = String(data.pinned).padStart(6);
    logger.logInfo(`   ${row.icon} ${row.label}  ${count}  ${pinned}  ${row.limit}`);
  }

  logger.logInfo('');
  logger.logInfo(`   ${style('RAG:', ['bold'])} ${describeEmbeddingStatus(CONFIG.rag)}`);
  if (status.rag_enabled) {
    logger.logInfo(
      `   ${style('Embeddings:', ['bold'])} ${status.embeddings_indexed}/${status.total_memories} indexed`
    );
  }
}

export const statusGroup: CommandGroup = {
  name: 'Status',
  helpEntries: [STATUS, STATUS_SPACE],
  commands: [
    {
      matches: args => STATUS_SPACE.matches(args),
      execute: async (args, store, logger) => {
        const { space } = STATUS_SPACE.getParams(args);
        renderStatus(store, logger, space);
      },
    },
    {
      matches: args => STATUS.matches(args),
      execute: async (args, store, logger) => {
        renderStatus(store, logger);
      },
    },
  ],
};
