// ── Sync CLI Commands ──
// Uses file-based config (.mind/config.yml)

import { existsSync, readFileSync, readdirSync, rmSync as _rmSync } from 'fs';
import { join } from 'path';

import { style } from '../../helpers/style';
import { AutoSyncService } from '../../sync/auto-sync-service';
import { loadConfig, saveConfig, initMindDir } from '../../sync/config-file';
import { shouldUpdateMemory } from '../../sync/conflict-resolver';
import { FileSyncService } from '../../sync/file-sync-service';
import { getSyncBasePath, getSpaceSyncDir, hashSpaceName } from '../../sync/normalize';
import type { ConflictResolution, MindSyncConfig } from '../../sync/types';
import { ArgParser } from '../arg-parser';

import type { CommandGroup } from './types';

// ── Argument Parsers ──

const INIT_PARSER = new ArgParser(
  ['sync init'],
  'Initialize .mind directory with config.yml and .gitignore',
  []
);

const STATUS_PARSER = new ArgParser(
  ['sync status', 'sync status', 'sync ls'],
  'Shows sync status for spaces',
  [{ name: 'space', alias: 's', hasValue: true, description: 'Filter by space name' }]
);

const ENABLE_PARSER = new ArgParser(['sync enable'], 'Enables autosync for a project space', [
  { name: 'space', alias: 's', hasValue: true, description: 'Space name' },
  { name: 'path', alias: 'p', hasValue: true, description: 'Base directory path for sync files' },
]);

const DISABLE_PARSER = new ArgParser(['sync disable'], 'Disables autosync for a project space', [
  { name: 'space', alias: 's', hasValue: true, description: 'Space name' },
]);

const NOW_PARSER = new ArgParser(['sync now'], 'Forces an immediate sync (export + import)', [
  { name: 'space', alias: 's', hasValue: true, description: 'Space name' },
]);

const EXPORT_PARSER = new ArgParser(['sync export'], 'Exports space memories to markdown files', [
  { name: 'space', alias: 's', hasValue: true, description: 'Space name' },
  { name: 'path', alias: 'p', hasValue: true, description: 'Base directory path' },
]);

const IMPORT_PARSER = new ArgParser(['sync import'], 'Imports markdown files into a space', [
  { name: 'space', alias: 's', hasValue: true, description: 'Space name' },
  { name: 'path', alias: 'p', hasValue: true, description: 'Base directory path' },
]);

const CONFLICT_PARSER = new ArgParser(
  ['sync conflict'],
  'Configures conflict resolution strategy',
  [
    { name: 'space', alias: 's', hasValue: true, description: 'Space name' },
    {
      name: 'strategy',
      hasValue: true,
      description: 'Resolution strategy: db-wins, file-wins, latest-wins',
    },
  ]
);

const SERVE_PARSER = new ArgParser(
  ['sync serve'],
  'Starts a file watcher for a space (foreground)',
  [{ name: 'space', alias: 's', hasValue: true, description: 'Space name to watch' }]
);

const REMOVE_PARSER = new ArgParser(['sync remove'], 'Removes a space from sync configuration', [
  { name: 'space', alias: 's', hasValue: true, description: 'Space name to remove' },
]);

const CONFIG_PARSER = new ArgParser(['sync config'], 'Shows the sync configuration', []);

const VALID_STRATEGIES: ConflictResolution[] = ['db-wins', 'file-wins', 'latest-wins'];

// ── Project root detection ──

function getProjectRoot(): string {
  return process.cwd();
}

// ── Config helpers ──

function getConfig(): MindSyncConfig {
  const basePath = getSyncBasePath(getProjectRoot());
  return loadConfig(basePath) ?? { version: 1, spaces: {} };
}

function updateConfig(updater: (config: MindSyncConfig) => MindSyncConfig): void {
  const basePath = getSyncBasePath(getProjectRoot());
  const config = getConfig();
  const updated = updater(config);
  saveConfig(basePath, updated);
}

// ── Import helper ──

interface ImportMemoryResult {
  imported: number;
  updated: number;
  failed: number;
  errors: string[];
}

/**
 * Import memories from a directory of markdown files into a space.
 * Uses conflict resolution strategy from file-based config.
 */
async function importFromDirectory(
  store: any,
  space: string,
  basePath: string,
  conflictResolution: ConflictResolution
): Promise<ImportMemoryResult> {
  const result: ImportMemoryResult = { imported: 0, updated: 0, failed: 0, errors: [] };

  if (!existsSync(basePath)) {
    result.errors.push(`Directory does not exist: ${basePath}`);
    return result;
  }

  const { parseFrontmatter } = await import('../../sync/frontmatter');
  const files = readdirSync(basePath).filter(f => f.endsWith('.md'));

  for (const file of files) {
    try {
      const filePath = join(basePath, file);
      const content = readFileSync(filePath, 'utf-8');

      // Parse frontmatter
      const { frontmatter, content: body } = parseFrontmatter(content);

      // Check if memory already exists
      const existing = store.getMemory(space, frontmatter.name);

      if (existing) {
        // Apply conflict resolution
        const shouldUpdate = shouldUpdateMemory(
          existing.changed_at,
          frontmatter.changed_at,
          conflictResolution
        );
        if (shouldUpdate) {
          const mem = store.getMemory(space, frontmatter.name);
          if (mem) {
            store.updateMemory(mem.id, { content: body });
            result.updated++;
          }
        }
      } else {
        // Create new memory
        await store.addMemory(space, frontmatter.name, body, {
          tags: frontmatter.tags,
          tier: frontmatter.tier,
          pinned: frontmatter.pinned,
        });
        result.imported++;
      }
    } catch (err) {
      result.failed++;
      result.errors.push(`Failed to import ${file}: ${err}`);
    }
  }

  return result;
}

// ── Command Group ──

export const syncGroup: CommandGroup = {
  name: 'Sync',
  helpEntries: [
    INIT_PARSER,
    STATUS_PARSER,
    ENABLE_PARSER,
    DISABLE_PARSER,
    NOW_PARSER,
    EXPORT_PARSER,
    IMPORT_PARSER,
    CONFLICT_PARSER,
    SERVE_PARSER,
    REMOVE_PARSER,
    CONFIG_PARSER,
  ],
  commands: [
    // ── sync init ──
    {
      matches: args => INIT_PARSER.matches(args),
      execute: async (_args, _store, logger) => {
        const projectRoot = getProjectRoot();
        const config = initMindDir(projectRoot);

        logger.logInfo(style('✅ Initialized .mind directory', ['green']));
        logger.logInfo(`  Config: ${join(projectRoot, '.mind', 'config.yml')}`);
        logger.logInfo(`  Version: ${config.version}`);
      },
    },

    // ── sync config ──
    {
      matches: args => CONFIG_PARSER.matches(args),
      execute: async (_args, _store, logger) => {
        const basePath = getSyncBasePath(getProjectRoot());
        const config = loadConfig(basePath);

        if (!config) {
          logger.logInfo(style('No sync config found. Run "sync init" first.', ['yellow']));
          return;
        }

        logger.logInfo('');
        logger.logInfo(' Sync Configuration');
        logger.logInfo(' '.repeat(62).replace(/ /g, '═'));
        logger.logInfo(`  Version: ${config.version}`);
        logger.logInfo(`  Config file: ${join(basePath, 'config.yml')}`);
        logger.logInfo('');
        logger.logInfo('  Spaces:');

        const spaceEntries = Object.entries(config.spaces);
        if (spaceEntries.length === 0) {
          logger.logInfo('    (none configured)');
        } else {
          for (const [spaceName, spaceConfig] of spaceEntries) {
            const statusIcon = spaceConfig.enabled
              ? style('✓', ['green'])
              : style('✗', ['red', 'bold']);
            const statusText = spaceConfig.enabled
              ? style('enabled', ['green'])
              : style('disabled', ['red']);
            const strategyText = style(spaceConfig.conflictResolution, ['cyan']);
            const hash = hashSpaceName(spaceName);

            logger.logInfo(`    ${statusIcon} ${spaceName}`);
            logger.logInfo(`       status: ${statusText}`);
            logger.logInfo(`       strategy: ${strategyText}`);
            logger.logInfo(`       path: .mind/spaces/${hash}/`);
          }
        }
        logger.logInfo('');
      },
    },

    // ── sync status ──
    {
      matches: args => STATUS_PARSER.matches(args),
      execute: async (args, _store, logger) => {
        const flags = STATUS_PARSER.getFlags(args);
        const spaceFilter = flags.space as string | undefined;

        const basePath = getSyncBasePath(getProjectRoot());
        const config = loadConfig(basePath);

        if (!config || Object.keys(config.spaces).length === 0) {
          logger.logInfo(style('No spaces configured for sync.', ['yellow']));
          logger.logInfo('Run "sync enable --space <name>" to enable a space.');
          return;
        }

        // Build status table
        const lines: string[] = [];
        lines.push('');
        lines.push(' Sync Status');
        lines.push(' '.repeat(62).replace(/ /g, '═'));
        lines.push('');

        for (const [spaceName, spaceConfig] of Object.entries(config.spaces)) {
          // Filter by space if specified
          if (spaceFilter && spaceName !== spaceFilter) {
            continue;
          }

          const statusIcon = spaceConfig.enabled
            ? style('✓', ['green'])
            : style('✗', ['red', 'bold']);
          const statusText = spaceConfig.enabled
            ? style('enabled', ['green'])
            : style('disabled', ['red']);
          const hash = hashSpaceName(spaceName);
          const pathDisplay = `.mind/spaces/${hash}/`;
          const strategyText = style(spaceConfig.conflictResolution, ['cyan']);

          lines.push(
            `${spaceName}`.padEnd(22) +
              `${statusIcon} ${statusText}`.padEnd(16) +
              `${strategyText}`.padEnd(14) +
              `${pathDisplay}`
          );
        }

        lines.push('');
        lines.push('─'.repeat(62));

        for (const line of lines) {
          logger.logInfo(line);
        }
      },
    },

    // ── sync enable ──
    {
      matches: args => ENABLE_PARSER.matches(args),
      execute: async (args, store, logger) => {
        const flags = ENABLE_PARSER.getFlags(args);
        const space = flags.space as string | undefined;

        if (!space) {
          logger.logInfo(style('❌ Space name is required (--space)', ['red']));
          return;
        }

        // Verify space exists in the store
        const spaceData = store.getSpace(space);
        if (!spaceData) {
          logger.logInfo(style(`❌ Space "${space}" not found`, ['red']));
          return;
        }

        // Initialize .mind directory
        const projectRoot = getProjectRoot();
        initMindDir(projectRoot);

        // Calculate the sync directory path
        const syncDir = getSpaceSyncDir(projectRoot, space);

        // Update config
        updateConfig(config => ({
          ...config,
          spaces: {
            ...config.spaces,
            [space]: {
              enabled: true,
              conflictResolution: config.spaces[space]?.conflictResolution ?? 'db-wins',
            },
          },
        }));

        // Export all memories to the path
        const fileSyncService = new FileSyncService(store);
        const exportResult = await fileSyncService.exportSpaceToFiles(
          space,
          getSyncBasePath(projectRoot)
        );

        if (exportResult.failed > 0) {
          logger.logInfo(
            style(`⚠ Enabled sync but ${exportResult.failed} files failed to export:`, ['yellow'])
          );
          for (const err of exportResult.errors) {
            logger.logInfo(style(`   - ${err}`, ['yellow']));
          }
        }

        const count = exportResult.exported;
        logger.logInfo(
          style(`✅ Autosync enabled for ${space}`, ['green']) +
            ` — ${count} memories exported to ${syncDir}`
        );
      },
    },

    // ── sync disable ──
    {
      matches: args => DISABLE_PARSER.matches(args),
      execute: async (args, _store, logger) => {
        const flags = DISABLE_PARSER.getFlags(args);
        const space = flags.space as string | undefined;

        if (!space) {
          logger.logInfo(style('❌ Space name is required (--space)', ['red']));
          return;
        }

        const config = getConfig();
        const spaceConfig = config.spaces[space];

        if (!spaceConfig) {
          logger.logInfo(style(`❌ No sync config found for "${space}"`, ['red']));
          return;
        }

        const syncDir = getSpaceSyncDir(getProjectRoot(), space);

        updateConfig(config => ({
          ...config,
          spaces: {
            ...config.spaces,
            [space]: {
              ...config.spaces[space]!,
              enabled: false,
            },
          },
        }));

        logger.logInfo(
          style(`✅ Autosync disabled for ${space}`, ['green']) + ' — files preserved at ' + syncDir
        );
      },
    },

    // ── sync now ──
    {
      matches: args => NOW_PARSER.matches(args),
      execute: async (args, store, logger) => {
        const flags = NOW_PARSER.getFlags(args);
        const space = flags.space as string | undefined;

        if (!space) {
          logger.logInfo(style('❌ Space name is required (--space)', ['red']));
          return;
        }

        const config = getConfig();
        const spaceConfig = config.spaces[space];

        if (!spaceConfig) {
          logger.logInfo(
            style(`❌ No sync config found for "${space}". Run "sync enable" first.`, ['red'])
          );
          return;
        }

        const projectRoot = getProjectRoot();
        const syncDir = getSpaceSyncDir(projectRoot, space);
        const resolution = spaceConfig.conflictResolution;

        // Write sync lock before export
        const autoSync = new AutoSyncService(store, projectRoot);
        autoSync.writeSyncLock(syncDir);

        // Step 1: Export DB → FS
        const fileSyncService = new FileSyncService(store);
        const exportResult = await fileSyncService.exportSpaceToFiles(
          space,
          getSyncBasePath(projectRoot)
        );

        // Clear sync lock after export
        autoSync.clearSyncLock(syncDir);

        // Step 2: Import FS → DB (detect external changes)
        const importResult = await importFromDirectory(store, space, syncDir, resolution);

        // Report
        logger.logInfo('');
        logger.logInfo(style(' Sync Now', ['bold']));
        logger.logInfo('─'.repeat(40));
        logger.logInfo(`  Export: ${exportResult.exported} files, ${exportResult.failed} failed`);
        logger.logInfo(
          `  Import: ${importResult.imported} new, ${importResult.updated} updated, ${importResult.failed} failed`
        );

        if (exportResult.errors.length > 0 || importResult.errors.length > 0) {
          logger.logInfo('');
          const allErrors = [...exportResult.errors, ...importResult.errors];
          for (const err of allErrors) {
            logger.logInfo(style(`  ⚠ ${err}`, ['yellow']));
          }
        }
      },
    },

    // ── sync export ──
    {
      matches: args => EXPORT_PARSER.matches(args),
      execute: async (args, store, logger) => {
        const flags = EXPORT_PARSER.getFlags(args);
        const space = flags.space as string | undefined;
        const customPath = flags.path as string | undefined;

        if (!space) {
          logger.logInfo(style('❌ Space name is required (--space)', ['red']));
          return;
        }

        // Verify space exists
        const spaceData = store.getSpace(space);
        if (!spaceData) {
          logger.logInfo(style(`❌ Space "${space}" not found`, ['red']));
          return;
        }

        const projectRoot = getProjectRoot();
        const syncDir = customPath ?? getSpaceSyncDir(projectRoot, space);

        // Export
        const fileSyncService = new FileSyncService(store);
        const exportBasePath = customPath ?? getSyncBasePath(projectRoot);
        const result = await fileSyncService.exportSpaceToFiles(space, exportBasePath);

        if (result.failed > 0) {
          logger.logInfo(
            style(`❌ Exported ${result.exported} files, ${result.failed} failed:`, ['red'])
          );
          for (const err of result.errors) {
            logger.logInfo(style(`   - ${err}`, ['red']));
          }
        } else {
          logger.logInfo(style(`✅ Exported ${result.exported} memories to ${syncDir}`, ['green']));
        }
      },
    },

    // ── sync import ──
    {
      matches: args => IMPORT_PARSER.matches(args),
      execute: async (args, store, logger) => {
        const flags = IMPORT_PARSER.getFlags(args);
        const space = flags.space as string | undefined;
        const customPath = flags.path as string | undefined;

        if (!space) {
          logger.logInfo(style('❌ Space name is required (--space)', ['red']));
          return;
        }

        // Verify space exists
        const spaceData = store.getSpace(space);
        if (!spaceData) {
          logger.logInfo(style(`❌ Space "${space}" not found`, ['red']));
          return;
        }

        const projectRoot = getProjectRoot();
        const syncDir = customPath ?? getSpaceSyncDir(projectRoot, space);
        const config = getConfig();
        const resolution = config.spaces[space]?.conflictResolution ?? 'db-wins';

        const result = await importFromDirectory(store, space, syncDir, resolution);

        if (result.failed > 0) {
          logger.logInfo(
            style(
              `⚠ Imported ${result.imported} new, ${result.updated} updated, ${result.failed} failed:`,
              ['yellow']
            )
          );
          for (const err of result.errors) {
            logger.logInfo(style(`   - ${err}`, ['yellow']));
          }
        } else {
          logger.logInfo(
            style(`✅ Imported ${result.imported} new, ${result.updated} updated from ${syncDir}`, [
              'green',
            ])
          );
        }
      },
    },

    // ── sync conflict ──
    {
      matches: args => CONFLICT_PARSER.matches(args),
      execute: async (args, _store, logger) => {
        const flags = CONFLICT_PARSER.getFlags(args);
        const space = flags.space as string | undefined;
        const strategy = flags.strategy as string | undefined;

        if (!space) {
          logger.logInfo(style('❌ Space name is required (--space)', ['red']));
          return;
        }

        if (!strategy) {
          logger.logInfo(style('❌ Strategy is required (--strategy)', ['red']));
          return;
        }

        // Validate strategy
        if (!VALID_STRATEGIES.includes(strategy as ConflictResolution)) {
          logger.logInfo(
            style(
              `❌ Invalid strategy "${strategy}". Valid options: ${VALID_STRATEGIES.join(', ')}`,
              ['red']
            )
          );
          return;
        }

        const config = getConfig();
        if (!config.spaces[space]) {
          logger.logInfo(
            style(`❌ No sync config found for "${space}". Run "sync enable" first.`, ['red'])
          );
          return;
        }

        updateConfig(config => ({
          ...config,
          spaces: {
            ...config.spaces,
            [space]: {
              ...config.spaces[space]!,
              conflictResolution: strategy as ConflictResolution,
            },
          },
        }));

        logger.logInfo(
          style(`✅ Conflict resolution set to "${strategy}" for ${space}`, ['green'])
        );
      },
    },

    // ── sync remove ──
    {
      matches: args => REMOVE_PARSER.matches(args),
      execute: async (args, _store, logger) => {
        const flags = REMOVE_PARSER.getFlags(args);
        const space = flags.space as string | undefined;

        if (!space) {
          logger.logInfo(style('❌ Space name is required (--space)', ['red']));
          return;
        }

        const config = getConfig();
        if (!config.spaces[space]) {
          logger.logInfo(style(`❌ No sync config found for "${space}"`, ['red']));
          return;
        }

        updateConfig(config => {
          const { [space]: _, ...remainingSpaces } = config.spaces;
          return { ...config, spaces: remainingSpaces };
        });

        logger.logInfo(style(`✅ Removed "${space}" from sync configuration`, ['green']));
        logger.logInfo('  Note: Memory files in .mind/spaces/ are preserved.');
      },
    },

    // ── sync serve ──
    {
      matches: args => SERVE_PARSER.matches(args),
      execute: async (args, store, logger) => {
        const flags = SERVE_PARSER.getFlags(args);
        const space = flags.space as string | undefined;

        if (!space) {
          logger.logInfo(style('❌ Space name is required (--space)', ['red']));
          return;
        }

        const config = getConfig();
        const spaceConfig = config.spaces[space];

        if (!spaceConfig) {
          logger.logInfo(
            style(`❌ No sync config found for "${space}". Run "sync enable" first.`, ['red'])
          );
          return;
        }

        if (!spaceConfig.enabled) {
          logger.logInfo(
            style(`❌ Sync is disabled for "${space}". Run "sync enable" first.`, ['red'])
          );
          return;
        }

        const projectRoot = getProjectRoot();
        const syncDir = getSpaceSyncDir(projectRoot, space);

        if (!existsSync(syncDir)) {
          logger.logInfo(style(`❌ Sync directory does not exist: ${syncDir}`, ['red']));
          return;
        }

        const autoSync = new AutoSyncService(store, projectRoot);

        await autoSync.startWatching(space);

        logger.logInfo(style(`👁 Watching ${syncDir} for changes...`, ['cyan']));
        logger.logInfo('Press Ctrl+C to stop.\n');

        // Log when events are processed
        let running = true;
        const statusInterval = setInterval(() => {
          if (running) {
            logger.logInfo(`[watching] ${space} — ${syncDir}`);
          }
        }, 10000);

        // Handle interrupt
        const cleanup = async () => {
          running = false;
          clearInterval(statusInterval);
          await autoSync.stopWatching(space);
          logger.logInfo(style('\n👁 Stopped watching.', ['yellow']));
          process.exit(0);
        };

        process.on('SIGINT', cleanup);
        process.on('SIGTERM', cleanup);

        // Keep the process alive
        await new Promise(() => {});
      },
    },
  ],
};
