export type EmbeddingProviderId = 'openai' | 'openrouter';

export interface EmbeddingProviderDefinition {
  id: EmbeddingProviderId;
  label: string;
  url: string;
  model: string;
  apiKeyEnvVar: string;
}

export interface EmbeddingSettings {
  enabled: boolean;
  provider: string | null;
  openaiApiKey: string | null;
  openrouterApiKey: string | null;
}

export interface ResolvedEmbeddingRuntime {
  provider: EmbeddingProviderDefinition;
  apiKey: string;
}

export const DEFAULT_EMBEDDING_PROVIDER: EmbeddingProviderId = 'openai';

export const EMBEDDING_PROVIDERS: Record<EmbeddingProviderId, EmbeddingProviderDefinition> = {
  openai: {
    id: 'openai',
    label: 'OpenAI',
    url: 'https://api.openai.com/v1/embeddings',
    model: 'text-embedding-3-small',
    apiKeyEnvVar: 'OPENAI_API_KEY',
  },
  openrouter: {
    id: 'openrouter',
    label: 'OpenRouter',
    url: 'https://openrouter.ai/api/v1/embeddings',
    model: 'openai/text-embedding-3-small',
    apiKeyEnvVar: 'OPENROUTER_API_KEY',
  },
};

export function resolveEmbeddingProvider(
  raw: string | null | undefined
): EmbeddingProviderId | null {
  const normalized = (raw ?? '').trim().toLowerCase();
  if (normalized === '') {
    return DEFAULT_EMBEDDING_PROVIDER;
  }
  return findEmbeddingProvider(normalized)?.id ?? null;
}

export function resolveEmbeddingRuntime(
  settings: EmbeddingSettings
): ResolvedEmbeddingRuntime | null {
  if (!settings.enabled) {
    return null;
  }

  const providerId = resolveEmbeddingProvider(settings.provider);
  if (!providerId) {
    return null;
  }

  const apiKey = resolveApiKey(providerId, settings);
  if (!apiKey) {
    return null;
  }

  return { provider: EMBEDDING_PROVIDERS[providerId], apiKey };
}

export function describeEmbeddingStatus(settings: EmbeddingSettings): string {
  if (!settings.enabled) {
    return 'disabled (set MIND_RAG=true)';
  }

  const providerId = resolveEmbeddingProvider(settings.provider);
  if (!providerId) {
    const rawValue = (settings.provider ?? '').trim();
    const expected = Object.keys(EMBEDDING_PROVIDERS).join(', ');
    return `disabled (invalid MIND_EMBEDDING_PROVIDER '${rawValue}'; expected: ${expected})`;
  }

  const apiKey = resolveApiKey(providerId, settings);
  if (!apiKey) {
    const { apiKeyEnvVar } = EMBEDDING_PROVIDERS[providerId];
    return `disabled (set ${apiKeyEnvVar} for provider '${providerId}')`;
  }

  return `enabled (provider: ${providerId})`;
}

function findEmbeddingProvider(raw: string): EmbeddingProviderDefinition | null {
  return (EMBEDDING_PROVIDERS as Record<string, EmbeddingProviderDefinition>)[raw] ?? null;
}

function resolveApiKey(
  providerId: EmbeddingProviderId,
  settings: EmbeddingSettings
): string | null {
  const apiKey = providerId === 'openai' ? settings.openaiApiKey : settings.openrouterApiKey;
  return apiKey || null;
}
