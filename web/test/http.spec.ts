import { afterEach, describe, expect, test } from 'bun:test';

import { ApiError, buildQuery, request } from '../src/api/http.js';

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
    ...init,
  });
}

describe('http request', () => {
  test('performs a GET and parses JSON', async () => {
    let capturedUrl: string | null = null;
    let capturedInit: RequestInit | undefined;
    globalThis.fetch = (async (input, init) => {
      capturedUrl = String(input);
      capturedInit = init;
      return jsonResponse({ ok: true });
    }) as typeof fetch;

    const result = await request('/api/thing');

    expect(result).toEqual({ ok: true });
    expect(capturedUrl).toBe('/api/thing');
    expect(capturedInit?.method).toBe('GET');
    expect((capturedInit?.headers as Record<string, string>)['Content-Type']).toBeUndefined();
    expect(capturedInit?.body).toBeUndefined();
  });

  test('serializes a body and sets the JSON content type', async () => {
    let capturedInit: RequestInit | undefined;
    globalThis.fetch = (async (_input, init) => {
      capturedInit = init;
      return jsonResponse({ ok: true }, { status: 201 });
    }) as typeof fetch;

    await request('/api/thing', { method: 'POST', body: { name: 'demo' } });

    expect(capturedInit?.method).toBe('POST');
    expect((capturedInit?.headers as Record<string, string>)['Content-Type']).toBe(
      'application/json'
    );
    expect(capturedInit?.body).toBe(JSON.stringify({ name: 'demo' }));
  });

  test('throws ApiError with status and parsed JSON body for JSON errors', async () => {
    globalThis.fetch = (async () =>
      jsonResponse({ error: 'Space not found' }, { status: 404 })) as unknown as typeof fetch;

    let error: unknown;
    try {
      await request('/api/spaces/missing');
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(ApiError);
    const apiError = error as ApiError;
    expect(apiError.status).toBe(404);
    expect(apiError.message).toBe('Space not found');
    expect(apiError.body).toEqual({ error: 'Space not found' });
  });

  test('uses a non-JSON error body in the ApiError message', async () => {
    globalThis.fetch = (async () =>
      new Response('<html>upstream failed</html>', {
        status: 502,
        headers: { 'Content-Type': 'text/html' },
      })) as unknown as typeof fetch;

    let error: unknown;
    try {
      await request('/api/thing');
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(ApiError);
    const apiError = error as ApiError;
    expect(apiError.status).toBe(502);
    expect(apiError.message).toContain('upstream failed');
    expect(apiError.body).toBe('<html>upstream failed</html>');
  });

  test('returns null for 204 and empty responses', async () => {
    globalThis.fetch = (async () => new Response(null, { status: 204 })) as unknown as typeof fetch;
    expect(await request('/api/thing')).toBeNull();

    globalThis.fetch = (async () => new Response('', { status: 200 })) as unknown as typeof fetch;
    expect(await request('/api/thing')).toBeNull();
  });

  test('forwards an AbortSignal and rejects when aborted', async () => {
    globalThis.fetch = ((_input, init) => {
      return new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          reject(new DOMException('Aborted', 'AbortError'));
        });
      });
    }) as typeof fetch;

    const controller = new AbortController();
    const pending = request('/api/thing', { signal: controller.signal });
    controller.abort();

    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
  });
});

describe('buildQuery', () => {
  test('omits undefined, null and empty string values', () => {
    expect(
      buildQuery({
        q: 'auth',
        missing: undefined,
        nullable: null,
        empty: '',
      })
    ).toBe('?q=auth');
  });

  test('keeps numeric and boolean values and encodes strings', () => {
    expect(buildQuery({ limit: 0, offset: 10, semantic: false, tag: 'cat:decision' })).toBe(
      '?limit=0&offset=10&semantic=false&tag=cat%3Adecision'
    );
  });

  test('returns an empty string when no values remain', () => {
    expect(buildQuery({})).toBe('');
    expect(buildQuery({ a: undefined, b: null, c: '' })).toBe('');
  });
});
