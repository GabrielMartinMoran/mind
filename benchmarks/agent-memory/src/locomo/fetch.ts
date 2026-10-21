// LoCoMo dataset download + sha256 + on-disk cache.
//
// The dataset is licensed CC BY-NC 4.0 and must never be vendored into the
// repository. It is downloaded at runtime into a gitignored cache directory
// (`.work/dataset/`), hashed, and the hash is recorded in the run metadata so a
// run is reproducible. `fetchFn` is injectable so tests can exercise the hash /
// cache / error paths without network access.

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';

import { DATASET } from '../config';

export const DATASET_ATTRIBUTION =
  'LoCoMo (snap-research/locomo), licensed CC BY-NC 4.0. Downloaded at runtime; ' +
  'never vendored into this repository. Subset artifacts are derived per run.';

/** Refuse to cache a suspiciously small payload (e.g. an HTML error page). */
export const MIN_DATASET_BYTES = 1024;

export class DatasetFetchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DatasetFetchError';
  }
}

export interface FetchResponse {
  readonly ok: boolean;
  readonly status: number;
  arrayBuffer(): Promise<ArrayBuffer>;
}

export type FetchLike = (url: string) => Promise<FetchResponse>;

export interface FetchedDataset {
  readonly path: string;
  readonly sha256: string;
  readonly bytes: number;
  readonly fromCache: boolean;
  readonly url: string;
  readonly attribution: string;
}

export interface FetchDatasetOptions {
  /** Directory the dataset is cached in (created if missing). */
  readonly cacheDir: string;
  readonly url?: string;
  /** When set, a mismatch (cached or downloaded) throws. */
  readonly expectedSha256?: string | null;
  readonly fetchFn?: FetchLike;
  /** Ignore the on-disk cache and re-download. */
  readonly force?: boolean;
}

export function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function cacheFileName(url: string): string {
  const name = basename(new URL(url).pathname);
  return name.length > 0 ? name : 'locomo10.json';
}

function validateHash(sha256: string, expected: string | null | undefined, source: string): void {
  if (expected && sha256 !== expected) {
    throw new DatasetFetchError(`${source} sha256 ${sha256} does not match expected ${expected}`);
  }
}

export async function fetchDataset(options: FetchDatasetOptions): Promise<FetchedDataset> {
  const url = options.url ?? DATASET.url;
  const cacheDir = options.cacheDir;
  const cachePath = join(cacheDir, cacheFileName(url));
  mkdirSync(cacheDir, { recursive: true });

  if (existsSync(cachePath) && !options.force) {
    const bytes = new Uint8Array(readFileSync(cachePath));
    const sha256 = sha256Hex(bytes);
    validateHash(sha256, options.expectedSha256, 'cached dataset');
    return {
      path: cachePath,
      sha256,
      bytes: bytes.byteLength,
      fromCache: true,
      url,
      attribution: DATASET_ATTRIBUTION,
    };
  }

  const fetchFn = options.fetchFn ?? (globalThis.fetch as unknown as FetchLike);
  let response: FetchResponse;
  try {
    response = await fetchFn(url);
  } catch (error) {
    throw new DatasetFetchError(`failed to download ${url}: ${String(error)}`);
  }
  if (!response.ok) {
    throw new DatasetFetchError(`download failed with status ${response.status} for ${url}`);
  }

  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength < MIN_DATASET_BYTES) {
    throw new DatasetFetchError(
      `dataset too small (${bytes.byteLength} bytes); refusing to cache a truncated payload`
    );
  }
  const sha256 = sha256Hex(bytes);
  validateHash(sha256, options.expectedSha256, 'downloaded dataset');

  const tmpPath = `${cachePath}.tmp`;
  writeFileSync(tmpPath, bytes);
  renameSync(tmpPath, cachePath);

  return {
    path: cachePath,
    sha256,
    bytes: bytes.byteLength,
    fromCache: false,
    url,
    attribution: DATASET_ATTRIBUTION,
  };
}
