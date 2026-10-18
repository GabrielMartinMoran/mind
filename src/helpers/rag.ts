import { CONFIG } from '../config';

import { resolveEmbeddingRuntime, type ResolvedEmbeddingRuntime } from './embedding-providers';

export type EmbeddingVector = number[] | Float32Array;

const MAX_ATTEMPTS = 3;

/**
 * How long an in-memory breaker stays open after a query-time embedding
 * failure. While open, semantic search is skipped entirely so a failing
 * provider (e.g. an expired key) cannot trigger a retry storm on every query.
 */
export const SEMANTIC_BREAKER_TTL_MS = 5 * 60 * 1000;

let semanticBreakerUntil = 0;

/**
 * True when a recent embedding failure should suppress further semantic
 * attempts. `nowMs` is injectable so the TTL is testable without real time.
 */
export function isSemanticBreakerOpen(nowMs: number = Date.now()): boolean {
  return nowMs < semanticBreakerUntil;
}

/** Open the semantic breaker for `ttlMs` from `nowMs`. */
export function recordSemanticFailure(
  nowMs: number = Date.now(),
  ttlMs: number = SEMANTIC_BREAKER_TTL_MS
): void {
  semanticBreakerUntil = nowMs + ttlMs;
}

/** Close the semantic breaker (test helper / explicit recovery). */
export function resetSemanticBreaker(): void {
  semanticBreakerUntil = 0;
}

export function isRagEnabled(): boolean {
  return resolveEmbeddingRuntime(CONFIG.rag) !== null;
}

export async function getEmbedding(text: string): Promise<Float32Array | null> {
  const runtime = resolveEmbeddingRuntime(CONFIG.rag);
  if (!runtime) {
    return null;
  }

  const embedding = await requestEmbedding(text, runtime);
  if (embedding === null) {
    // Runtime was configured, so a null result is a real failure — trip the
    // breaker so subsequent queries skip the provider instead of retrying.
    recordSemanticFailure();
  }
  return embedding;
}

export async function requestEmbedding(
  input: string,
  runtime: ResolvedEmbeddingRuntime
): Promise<Float32Array | null> {
  const { provider, apiKey } = runtime;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const response = await fetch(provider.url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model: provider.model,
          input,
          encoding_format: 'float',
        }),
      });

      if (!response.ok) {
        const isLast = attempt === MAX_ATTEMPTS;
        logAttempt(
          `${provider.label} API error: ${response.status} ${response.statusText}`,
          attempt,
          isLast
        );
        if (isLast) return null;
      } else {
        const data = (await response.json()) as {
          data: { embedding: number[] }[];
        };
        const embedding = data.data[0]?.embedding;
        return embedding ? new Float32Array(embedding) : null;
      }
    } catch (e: any) {
      const isLast = attempt === MAX_ATTEMPTS;
      logAttempt(`Failed to get embedding: ${e.message}`, attempt, isLast);
      if (isLast) return null;
    }

    await delayBeforeRetry(attempt);
  }

  return null;
}

function logAttempt(reason: string, attempt: number, isLast: boolean): void {
  const outcome = isLast ? 'giving up' : 'retrying...';
  const message = `[RAG] ${reason} (attempt ${attempt}/${MAX_ATTEMPTS}) — ${outcome}`;
  if (isLast) {
    console.error(message);
  } else {
    console.warn(message);
  }
}

function delayBeforeRetry(attempt: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, 1000 * attempt));
}

export function cosineSimilarity(a: EmbeddingVector, b: EmbeddingVector): number {
  if (a.length !== b.length) {
    throw new Error(`Vector dimension mismatch: ${a.length} vs ${b.length}`);
  }

  let dotProduct = 0;
  let normA = 0;
  let normB = 0;

  for (let i = 0; i < a.length; i++) {
    dotProduct += a[i]! * b[i]!;
    normA += a[i]! * a[i]!;
    normB += b[i]! * b[i]!;
  }

  const denominator = Math.sqrt(normA) * Math.sqrt(normB);
  if (denominator === 0) {
    return 0;
  }

  return dotProduct / denominator;
}

export interface ScoredMemory {
  id: string;
  score: number;
}

export async function semanticSearch(
  query: string,
  getMemoryEmbedding: (_id: string) => Float32Array | null,
  memoryIds: string[]
): Promise<ScoredMemory[]> {
  const queryEmbedding = await getEmbedding(query);
  if (!queryEmbedding) {
    return [];
  }

  const results: ScoredMemory[] = [];

  for (const id of memoryIds) {
    const memEmbedding = getMemoryEmbedding(id);
    if (!memEmbedding) {
      continue;
    }

    // Convert Float32Array to number[] for cosineSimilarity
    const vec = Array.from(memEmbedding);
    const score = cosineSimilarity(queryEmbedding, vec);
    results.push({ id, score });
  }

  // Sort by score descending
  results.sort((a, b) => b.score - a.score);

  return results;
}

export function vectorToBlob(vector: EmbeddingVector): Uint8Array {
  const buffer = new Float32Array(vector).buffer;
  return new Uint8Array(buffer);
}

export function blobToVector(blob: Uint8Array): Float32Array {
  return new Float32Array(blob.buffer);
}
