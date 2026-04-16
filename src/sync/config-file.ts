// ── Config file handling for .mind/config.yml ──

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join } from 'path';

import YAML from 'yaml';

import type { MindSyncConfig, SpaceSyncConfig } from './types';

const CONFIG_FILENAME = 'config.yml';
const GITIGNORE_CONTENT = `.mind-sync/\n.syncing\n`;

// Default config content with comments (written as string to preserve comments)
const DEFAULT_CONFIG_CONTENT = `# mind autosync config

version: 1

# Spaces to sync with this project
# To enable a new space, add it below with enabled: true
# Valid conflictResolution values: db-wins, file-wins, latest-wins
spaces:
  # projects/mind:
  #   enabled: true
  #   conflictResolution: db-wins
`;

// Typed default for runtime use (no comments)
const DEFAULT_CONFIG: MindSyncConfig = {
  version: 1,
  spaces: {},
};

/**
 * Get the path to the sync config file.
 */
export function getConfigPath(basePath: string): string {
  return join(basePath, CONFIG_FILENAME);
}

/**
 * Load sync config from .mind/config.yml.
 * Returns null if config file doesn't exist.
 */
export function loadConfig(basePath: string): MindSyncConfig | null {
  const path = getConfigPath(basePath);
  if (!existsSync(path)) {
    return null;
  }
  try {
    const content = readFileSync(path, 'utf8');
    const parsed = YAML.parse(content) as MindSyncConfig;
    // Validate required fields
    if (typeof parsed.version !== 'number') {
      return null;
    }
    if (!parsed.spaces || typeof parsed.spaces !== 'object') {
      parsed.spaces = {};
    }
    return parsed;
  } catch {
    return null;
  }
}

/**
 * Build the YAML content for spaces section.
 * Manual construction preserves comments in the template.
 */
function buildSpacesYaml(spaces: Record<string, SpaceSyncConfig>): string {
  const lines: string[] = [];

  for (const [spaceName, spaceConfig] of Object.entries(spaces)) {
    lines.push(`  ${spaceName}:`);
    lines.push(`    enabled: ${spaceConfig.enabled}`);
    lines.push(`    conflictResolution: ${spaceConfig.conflictResolution}`);
  }

  return lines.join('\n');
}

/**
 * Save sync config to .mind/config.yml.
 * Uses manual YAML construction to preserve comments.
 */
export function saveConfig(basePath: string, config: MindSyncConfig): void {
  const path = getConfigPath(basePath);
  // Ensure .mind directory exists
  if (!existsSync(basePath)) {
    mkdirSync(basePath, { recursive: true });
  }

  const spacesYaml = buildSpacesYaml(config.spaces);

  const content = `# mind autosync config

version: 1

# Spaces to sync with this project
# To enable a new space, add it below with enabled: true
# Valid conflictResolution values: db-wins, file-wins, latest-wins
spaces:
${spacesYaml}
`;

  writeFileSync(path, content, 'utf8');
}

/**
 * Ensure config exists, creating with defaults if missing.
 * Returns the config (existing or newly created).
 */
export function ensureConfig(basePath: string): MindSyncConfig {
  const config = loadConfig(basePath);
  if (config) {
    return config;
  }
  // Create default config with comments (write as string to preserve them)
  const path = getConfigPath(basePath);
  if (!existsSync(basePath)) {
    mkdirSync(basePath, { recursive: true });
  }
  writeFileSync(path, DEFAULT_CONFIG_CONTENT, 'utf8');
  return DEFAULT_CONFIG;
}

/**
 * Get gitignore path in the .mind directory.
 */
export function getGitignorePath(basePath: string): string {
  return join(basePath, '.gitignore');
}

/**
 * Ensure .gitignore exists in the .mind directory with proper content.
 */
export function ensureGitignore(basePath: string): void {
  const path = getGitignorePath(basePath);
  if (existsSync(path)) {
    return; // already exists
  }
  writeFileSync(path, GITIGNORE_CONTENT, 'utf8');
}

/**
 * Get the path to the .mind directory (basePath).
 */
export function getMindDir(projectRoot: string): string {
  return join(projectRoot, '.mind');
}

/**
 * Initialize .mind directory with config.yml and .gitignore.
 * Does NOT overwrite existing config.
 */
export function initMindDir(projectRoot: string): MindSyncConfig {
  const basePath = getMindDir(projectRoot);

  // Ensure directory exists
  if (!existsSync(basePath)) {
    mkdirSync(basePath, { recursive: true });
  }

  // Ensure gitignore
  ensureGitignore(basePath);

  // Ensure config (creates with defaults if missing)
  const config = ensureConfig(basePath);

  return config;
}

/**
 * Check if .mind/config.yml exists.
 */
export function hasConfig(projectRoot: string): boolean {
  return existsSync(getConfigPath(getMindDir(projectRoot)));
}

/**
 * Get all enabled spaces from config.
 */
export function getEnabledSpaces(
  config: MindSyncConfig
): Array<{ spaceName: string; config: SpaceSyncConfig }> {
  return Object.entries(config.spaces)
    .filter(([, spaceConfig]) => spaceConfig.enabled)
    .map(([spaceName, spaceConfig]) => ({ spaceName, config: spaceConfig }));
}

/**
 * Add or update a space in the config.
 */
export function setSpaceConfig(
  config: MindSyncConfig,
  spaceName: string,
  spaceConfig: SpaceSyncConfig
): MindSyncConfig {
  return {
    ...config,
    spaces: {
      ...config.spaces,
      [spaceName]: spaceConfig,
    },
  };
}

/**
 * Remove a space from the config.
 */
export function removeSpaceConfig(config: MindSyncConfig, spaceName: string): MindSyncConfig {
  const { [spaceName]: _, ...remainingSpaces } = config.spaces;
  return {
    ...config,
    spaces: remainingSpaces,
  };
}

/**
 * Get a specific space's config.
 */
export function getSpaceConfig(config: MindSyncConfig, spaceName: string): SpaceSyncConfig | null {
  return config.spaces[spaceName] ?? null;
}
