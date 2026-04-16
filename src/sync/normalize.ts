// ── Space name normalization and path helpers ──

import { createHash } from 'crypto';
import { existsSync, mkdirSync, writeFileSync, readFileSync } from 'fs';
import { join } from 'path';

import type { SpaceManifest } from './types';

/**
 * Hash a space name to an 8-character hex string.
 * Used for directory naming in .mind/spaces/<hash>/
 */
export function hashSpaceName(spaceName: string): string {
  return createHash('sha256').update(spaceName).digest('hex').substring(0, 8);
}

/**
 * Get the directory path for a space's sync files.
 * Format: .mind/spaces/<hash>/
 */
export function getSpaceDir(basePath: string, spaceName: string): string {
  const hash = hashSpaceName(spaceName);
  return join(basePath, 'spaces', hash);
}

/**
 * Get the manifest.json path for a space.
 */
export function getManifestPath(spaceDir: string): string {
  return join(spaceDir, 'manifest.json');
}

/**
 * Ensure the space directory exists and has a manifest.json.
 * Creates the directory and manifest if they don't exist.
 * Returns the space directory path.
 */
export function ensureSpaceDir(basePath: string, spaceName: string): string {
  const dir = getSpaceDir(basePath, spaceName);

  // Ensure directory exists
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  // Write manifest.json if it doesn't exist
  const manifestPath = getManifestPath(dir);
  if (!existsSync(manifestPath)) {
    const manifest: SpaceManifest = { space: spaceName };
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf8');
  }

  return dir;
}

/**
 * Read and parse a manifest.json file.
 * Returns null if manifest doesn't exist.
 */
export function readManifest(spaceDir: string): SpaceManifest | null {
  const manifestPath = getManifestPath(spaceDir);
  if (!existsSync(manifestPath)) {
    return null;
  }
  try {
    const content = readFileSync(manifestPath, 'utf8');
    return JSON.parse(content) as SpaceManifest;
  } catch {
    return null;
  }
}

/**
 * Get the sync base path for a project (projectRoot/.mind).
 */
export function getSyncBasePath(projectRoot: string): string {
  return join(projectRoot, '.mind');
}

/**
 * Find the project root by looking for .mind/config.yml in the given path
 * or any parent directory.
 * Returns null if not found.
 */
export function findProjectRoot(startPath: string): string | null {
  let current = startPath;

  // Limit search to reasonable depth
  for (let i = 0; i < 20; i++) {
    const configPath = join(current, '.mind', 'config.yml');
    if (existsSync(configPath)) {
      return current;
    }

    const parent = join(current, '..');
    if (parent === current) {
      break; // Reached filesystem root
    }
    current = parent;
  }

  return null;
}

/**
 * Get the sync directory for a specific space.
 * Requires projectRoot to be provided since config is file-based.
 */
export function getSpaceSyncDir(projectRoot: string, spaceName: string): string {
  const basePath = getSyncBasePath(projectRoot);
  return getSpaceDir(basePath, spaceName);
}
