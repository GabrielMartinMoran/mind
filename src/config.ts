import * as path from 'path';

const repoRoot = path.join(import.meta.dir, '..');
const dataDir = process.env.MIND_DATA_DIR ?? 'data';

const resolvedDataDir = path.isAbsolute(dataDir) ? dataDir : path.join(repoRoot, dataDir);

/**
 * MIND_DB_PATH overrides the full database file path (useful for testing with a temp DB).
 * Falls back to MIND_DATA_DIR/mind.db.
 */
const dbPath = process.env.MIND_DB_PATH ?? path.join(resolvedDataDir, 'mind.db');

/**
 * MIND_PORT sets the default web server port (default: 30303).
 * CLI --port flag overrides this; MIND_PORT env var overrides the default.
 */
export const DEFAULT_PORT = 30303;

export const CONFIG = {
  defaultPort: DEFAULT_PORT,
  dataDir: resolvedDataDir,
  dbPath,
  /** Legacy JSON path for migration */
  legacyJsonPath: path.join(resolvedDataDir, 'brain.json'),
  /** Log retention in minutes (default: 6 hours = 360 minutes). Override with MIND_LOG_RETENTION_MINUTES. */
  logRetentionMinutes: parseInt(process.env.MIND_LOG_RETENTION_MINUTES ?? '360', 10),
  /** RAG: Enable semantic search with a selectable embeddings provider (MIND_EMBEDDING_PROVIDER) */
  rag: {
    enabled: process.env.MIND_RAG === 'true',
    provider: process.env.MIND_EMBEDDING_PROVIDER ?? null,
    openaiApiKey: process.env.OPENAI_API_KEY ?? null,
    openrouterApiKey: process.env.OPENROUTER_API_KEY ?? null,
    model: 'text-embedding-3-small',
  },
};

/**
 * Max non-pinned memories per space per tier.
 * T3 is unlimited (not included here).
 */
export const TIER_LIMITS: Record<1 | 2, number> = {
  1: 25,
  2: 50,
};
