import { afterEach, describe, expect, spyOn, test } from 'bun:test';

import {
  DEFAULT_EMBEDDING_PROVIDER,
  EMBEDDING_PROVIDERS,
  describeEmbeddingStatus,
  resolveEmbeddingProvider,
  resolveEmbeddingRuntime,
  type EmbeddingSettings,
} from '../src/helpers/embedding-providers';
import { requestEmbedding } from '../src/helpers/rag';

const OPENAI_URL = 'https://api.openai.com/v1/embeddings';
const OPENROUTER_URL = 'https://openrouter.ai/api/v1/embeddings';

function settings(overrides: Partial<EmbeddingSettings> = {}): EmbeddingSettings {
  return {
    enabled: true,
    provider: null,
    openaiApiKey: 'openai-test-key',
    openrouterApiKey: 'openrouter-test-key',
    ...overrides,
  };
}

function embeddingResponse(values: number[] = new Array(1536).fill(0.1)): Response {
  return new Response(JSON.stringify({ data: [{ embedding: values }] }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

let restoreFetch: (() => void) | null = null;
let restoreConsoleWarn: (() => void) | null = null;
let restoreConsoleError: (() => void) | null = null;

afterEach(() => {
  restoreFetch?.();
  restoreConsoleWarn?.();
  restoreConsoleError?.();
  restoreFetch = null;
  restoreConsoleWarn = null;
  restoreConsoleError = null;
});

describe('resolveEmbeddingProvider', () => {
  test('defaults to openai when the configured value is unset, null, or blank', () => {
    expect(DEFAULT_EMBEDDING_PROVIDER).toBe('openai');
    expect(resolveEmbeddingProvider(undefined)).toBe('openai');
    expect(resolveEmbeddingProvider(null)).toBe('openai');
    expect(resolveEmbeddingProvider('')).toBe('openai');
    expect(resolveEmbeddingProvider('   ')).toBe('openai');
  });

  test('resolves explicit provider ids', () => {
    expect(resolveEmbeddingProvider('openai')).toBe('openai');
    expect(resolveEmbeddingProvider('openrouter')).toBe('openrouter');
  });

  test('normalizes case and surrounding whitespace before matching', () => {
    expect(resolveEmbeddingProvider(' OpenRouter ')).toBe('openrouter');
    expect(resolveEmbeddingProvider('\tOPENAI')).toBe('openai');
  });

  test('returns null for unknown provider values without falling back', () => {
    expect(resolveEmbeddingProvider('huggingface')).toBeNull();
  });
});

describe('EMBEDDING_PROVIDERS registry', () => {
  test('openai definition targets the OpenAI embeddings endpoint', () => {
    expect(EMBEDDING_PROVIDERS.openai).toEqual({
      id: 'openai',
      label: 'OpenAI',
      url: OPENAI_URL,
      model: 'text-embedding-3-small',
      apiKeyEnvVar: 'OPENAI_API_KEY',
    });
  });

  test('openrouter definition targets the OpenRouter embeddings endpoint', () => {
    expect(EMBEDDING_PROVIDERS.openrouter).toEqual({
      id: 'openrouter',
      label: 'OpenRouter',
      url: OPENROUTER_URL,
      model: 'openai/text-embedding-3-small',
      apiKeyEnvVar: 'OPENROUTER_API_KEY',
    });
  });
});

describe('resolveEmbeddingRuntime', () => {
  test('defaults to the OpenAI runtime when no provider is configured', () => {
    const runtime = resolveEmbeddingRuntime(settings());

    expect(runtime?.provider.id).toBe('openai');
    expect(runtime?.provider.url).toBe(OPENAI_URL);
    expect(runtime?.provider.model).toBe('text-embedding-3-small');
    expect(runtime?.apiKey).toBe('openai-test-key');
  });

  test('uses the OpenRouter runtime and only its key when selected explicitly', () => {
    const runtime = resolveEmbeddingRuntime(settings({ provider: 'openrouter' }));

    expect(runtime?.provider.id).toBe('openrouter');
    expect(runtime?.provider.url).toBe(OPENROUTER_URL);
    expect(runtime?.provider.model).toBe('openai/text-embedding-3-small');
    expect(runtime?.apiKey).toBe('openrouter-test-key');
  });

  test('normalizes the provider value before selecting the runtime', () => {
    const runtime = resolveEmbeddingRuntime(settings({ provider: ' OpenRouter ' }));

    expect(runtime?.provider.id).toBe('openrouter');
    expect(runtime?.apiKey).toBe('openrouter-test-key');
  });

  test('returns null for an unknown provider value', () => {
    expect(resolveEmbeddingRuntime(settings({ provider: 'huggingface' }))).toBeNull();
  });

  test('returns null when the selected provider key is missing even if the other key is set', () => {
    expect(
      resolveEmbeddingRuntime(settings({ provider: 'openrouter', openrouterApiKey: null }))
    ).toBeNull();
    expect(resolveEmbeddingRuntime(settings({ openaiApiKey: null }))).toBeNull();
  });

  test('treats an empty selected-provider key as missing', () => {
    expect(resolveEmbeddingRuntime(settings({ openaiApiKey: '' }))).toBeNull();
  });

  test('returns null when RAG is disabled regardless of provider and keys', () => {
    expect(
      resolveEmbeddingRuntime(
        settings({ enabled: false, provider: 'openrouter', openrouterApiKey: 'key' })
      )
    ).toBeNull();
  });
});

describe('describeEmbeddingStatus', () => {
  test('reports disabled when RAG is off', () => {
    expect(describeEmbeddingStatus(settings({ enabled: false }))).toBe(
      'disabled (set MIND_RAG=true)'
    );
  });

  test('reports the invalid provider value when selection is unknown', () => {
    expect(describeEmbeddingStatus(settings({ provider: ' huggingface ' }))).toBe(
      "disabled (invalid MIND_EMBEDDING_PROVIDER 'huggingface'; expected: openai, openrouter)"
    );
  });

  test('hints the missing env var for the selected provider', () => {
    expect(
      describeEmbeddingStatus(settings({ provider: 'openrouter', openrouterApiKey: null }))
    ).toBe("disabled (set OPENROUTER_API_KEY for provider 'openrouter')");
    expect(describeEmbeddingStatus(settings({ openaiApiKey: null }))).toBe(
      "disabled (set OPENAI_API_KEY for provider 'openai')"
    );
  });

  test('reports the active provider when the runtime is usable', () => {
    expect(describeEmbeddingStatus(settings())).toBe('enabled (provider: openai)');
    expect(describeEmbeddingStatus(settings({ provider: 'openrouter' }))).toBe(
      'enabled (provider: openrouter)'
    );
  });
});

describe('requestEmbedding', () => {
  test('shapes the OpenRouter request with the model slug, auth header, and float encoding', async () => {
    const fetchSpy = spyOn(globalThis, 'fetch').mockResolvedValue(embeddingResponse());
    restoreFetch = () => fetchSpy.mockRestore();

    const runtime = resolveEmbeddingRuntime(settings({ provider: 'openrouter' }))!;
    await requestEmbedding('hello world', runtime);

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0]!;
    expect(String(url)).toBe(OPENROUTER_URL);
    expect(init?.method).toBe('POST');

    const headers = init?.headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer openrouter-test-key');
    expect(headers['Content-Type']).toBe('application/json');

    const body = JSON.parse(String(init?.body));
    expect(body).toEqual({
      model: 'openai/text-embedding-3-small',
      input: 'hello world',
      encoding_format: 'float',
    });
  });

  test('shapes the OpenAI request with the base model slug and its own key', async () => {
    const fetchSpy = spyOn(globalThis, 'fetch').mockResolvedValue(embeddingResponse());
    restoreFetch = () => fetchSpy.mockRestore();

    const runtime = resolveEmbeddingRuntime(settings())!;
    await requestEmbedding('hello world', runtime);

    const [url, init] = fetchSpy.mock.calls[0]!;
    expect(String(url)).toBe(OPENAI_URL);

    const headers = init?.headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer openai-test-key');

    const body = JSON.parse(String(init?.body));
    expect(body.model).toBe('text-embedding-3-small');
    expect(body.encoding_format).toBe('float');
  });

  test('converts the returned embedding into a Float32Array', async () => {
    const fetchSpy = spyOn(globalThis, 'fetch').mockResolvedValue(embeddingResponse());
    restoreFetch = () => fetchSpy.mockRestore();

    const runtime = resolveEmbeddingRuntime(settings({ provider: 'openrouter' }))!;
    const vector = await requestEmbedding('hello world', runtime);

    expect(vector).toBeInstanceOf(Float32Array);
    expect(vector!.length).toBe(1536);
    expect(vector![0]).toBeCloseTo(0.1, 5);
    expect(vector![1535]).toBeCloseTo(0.1, 5);
  });

  test('returns null after retrying when the endpoint keeps failing', async () => {
    const fetchSpy = spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('server error', { status: 500, statusText: 'Internal Server Error' })
    );
    restoreFetch = () => fetchSpy.mockRestore();

    const warnSpy = spyOn(console, 'warn').mockImplementation(() => {});
    restoreConsoleWarn = () => warnSpy.mockRestore();
    const errorSpy = spyOn(console, 'error').mockImplementation(() => {});
    restoreConsoleError = () => errorSpy.mockRestore();

    const runtime = resolveEmbeddingRuntime(settings())!;
    const vector = await requestEmbedding('hello world', runtime);

    expect(vector).toBeNull();

    // Scope assertions to this request: the shared console/fetch globals can see
    // unrelated background activity while the retry backoff (~3s) is running.
    const embeddingCalls = fetchSpy.mock.calls.filter(([url]) => String(url) === OPENAI_URL);
    expect(embeddingCalls).toHaveLength(3);

    const retryWarnings = warnSpy.mock.calls
      .map(call => String(call[0] ?? ''))
      .filter(message => message.includes('OpenAI API error'));
    expect(retryWarnings).toHaveLength(2);

    const finalError = errorSpy.mock.calls
      .map(call => String(call[0] ?? ''))
      .find(message => message.includes('OpenAI API error'));
    expect(finalError).toContain('giving up');
  }, 10000);
});
