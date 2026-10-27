import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, test } from 'bun:test';

import {
  DATASET_ATTRIBUTION,
  DatasetFetchError,
  MIN_DATASET_BYTES,
  fetchDataset,
  sha256Hex,
} from '../src/locomo/fetch';
import type { FetchResponse } from '../src/locomo/fetch';

const URL = 'https://example.test/locomo10.json';
const PAYLOAD = new TextEncoder().encode(`x${'y'.repeat(MIN_DATASET_BYTES)}`);
const HASH = sha256Hex(PAYLOAD);

function fakeFetch(response: Partial<FetchResponse> & { bytes?: Uint8Array } = {}): {
  fetchFn: (url: string) => Promise<FetchResponse>;
  calls: () => number;
} {
  let calls = 0;
  const fetchFn = (): Promise<FetchResponse> => {
    calls += 1;
    const body = response.bytes ?? PAYLOAD;
    return Promise.resolve({
      ok: response.ok ?? true,
      status: response.status ?? 200,
      arrayBuffer: async () =>
        body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength) as ArrayBuffer,
    });
  };
  return { fetchFn, calls: () => calls };
}

function cacheDir(): string {
  return mkdtempSync(join(tmpdir(), 'bench-fetch-'));
}

describe('fetchDataset', () => {
  test('downloads, hashes, caches and reports provenance', async () => {
    const dir = cacheDir();
    const { fetchFn } = fakeFetch();
    const first = await fetchDataset({ cacheDir: dir, url: URL, fetchFn, expectedSha256: HASH });

    expect(first.fromCache).toBe(false);
    expect(first.sha256).toBe(HASH);
    expect(first.bytes).toBe(PAYLOAD.byteLength);
    expect(first.attribution).toBe(DATASET_ATTRIBUTION);
    expect(readFileSync(first.path).byteLength).toBe(PAYLOAD.byteLength);

    // Second call reuses the cache and does not hit the network again.
    const second = await fetchDataset({ cacheDir: dir, url: URL, fetchFn, expectedSha256: HASH });
    expect(second.fromCache).toBe(true);
    expect(second.sha256).toBe(HASH);
  });

  test('rejects a hash mismatch on download', async () => {
    const dir = cacheDir();
    await expect(
      fetchDataset({
        cacheDir: dir,
        url: URL,
        fetchFn: fakeFetch().fetchFn,
        expectedSha256: 'nope',
      })
    ).rejects.toThrow(DatasetFetchError);
  });

  test('rejects a hash mismatch on an existing cache file', async () => {
    const dir = cacheDir();
    writeFileSync(join(dir, 'locomo10.json'), PAYLOAD);
    await expect(
      fetchDataset({
        cacheDir: dir,
        url: URL,
        fetchFn: fakeFetch().fetchFn,
        expectedSha256: 'nope',
      })
    ).rejects.toThrow(DatasetFetchError);
  });

  test('rejects a non-ok response', async () => {
    const dir = cacheDir();
    await expect(
      fetchDataset({
        cacheDir: dir,
        url: URL,
        fetchFn: fakeFetch({ ok: false, status: 404 }).fetchFn,
        expectedSha256: null,
      })
    ).rejects.toThrow('status 404');
  });

  test('refuses to cache a truncated payload', async () => {
    const dir = cacheDir();
    await expect(
      fetchDataset({
        cacheDir: dir,
        url: URL,
        fetchFn: fakeFetch({ bytes: new TextEncoder().encode('too small') }).fetchFn,
        expectedSha256: null,
      })
    ).rejects.toThrow('too small');
  });

  test('wraps network failures in a typed error', async () => {
    const dir = cacheDir();
    await expect(
      fetchDataset({
        cacheDir: dir,
        url: URL,
        fetchFn: () => Promise.reject(new Error('offline')),
        expectedSha256: null,
      })
    ).rejects.toThrow(DatasetFetchError);
  });
});
