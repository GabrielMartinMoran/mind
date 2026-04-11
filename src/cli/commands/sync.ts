// ── Sync CLI Commands ──

import { existsSync, readFileSync, readdirSync } from 'fs';
import { join } from 'path';

import { style } from '../../helpers/style';
import { AutoSyncService } from '../../sync/auto-sync-service';
import { shouldUpdateMemory } from '../../sync/conflict-resolver';
import type { ConflictResolution } from '../../sync/types';
import { ArgParser } from '../arg-parser';

import type { CommandGroup } from './types';

// ── Argument Parsers ──

const STATUS_PARSER = new ArgParser(['sync status|sync ls'], 'Shows sync status for spaces', [
  { name: 'space', alias: 's', hasValue: true, description: 'Filter by space name' },
]);

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

const VALID_STRATEGIES: ConflictResolution[] = ['db-wins', 'file-wins', 'latest-wins'];

// ── Import helper ──

interface ImportMemoryResult {
  imported: number;
  updated: number;
  failed: number;
  errors: string[];
}

/**
 * Import memories from a directory of markdown files into a space.
 * Uses conflict resolution strategy from sync_config.
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

  const files = readdirSync(basePath).filter(f => f.endsWith('.md'));

  for (const file of files) {
    try {
      const filePath = join(basePath, file);
      const content = readFileSync(filePath, 'utf-8');

      // Parse frontmatter
      const { parseFrontmatter } = await import('../../sync/frontmatter');
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
    STATUS_PARSER,
    ENABLE_PARSER,
    DISABLE_PARSER,
    NOW_PARSER,
    EXPORT_PARSER,
    IMPORT_PARSER,
    CONFLICT_PARSER,
    SERVE_PARSER,
  ],
  commands: [
    // ── sync status ──
    {
      matches: args => STATUS_PARSER.matches(args),
      execute: async (args, store, logger) => {
        const flags = STATUS_PARSER.getFlags(args);
        const spaceFilter = flags.space as string | undefined;

        const configs = store.listSyncConfigs();

        if (configs.length === 0) {
          logger.logInfo(style('No spaces configured for sync.', ['yellow']));
          return;
        }

        // Filter by space if specified
        const filtered = spaceFilter ? configs.filter(c => c.spaceName === spaceFilter) : configs;

        if (filtered.length === 0) {
          if (spaceFilter) {
            logger.logInfo(style(`No sync config found for space "${spaceFilter}"`, ['yellow']));
          }
          return;
        }

        // Build status table
        const lines: string[] = [];
        lines.push('');
        lines.push(' Sync Status');
        lines.push(' '.repeat(62).replace(/ /g, '═'));
        lines.push('');

        for (const config of filtered) {
          const statusIcon = config.enabled ? style('✓', ['green']) : style('✗', ['red', 'bold']);
          const statusText = config.enabled
            ? style('enabled', ['green'])
            : style('disabled', ['red']);
          const pathDisplay =
            config.basePath.length > 15 ? '...' + config.basePath.slice(-12) : config.basePath;
          const lastExport = config.lastExportedAt
            ? config.lastExportedAt.slice(0, 16).replace('T', ' ')
            : style('never', ['dim']);
          const strategyText = style(config.conflictResolution, ['cyan']);

          lines.push(
            `${config.spaceName}`.padEnd(22) +
              `${statusIcon} ${statusText}`.padEnd(16) +
              `${strategyText}`.padEnd(14) +
              `${pathDisplay}`.padEnd(16) +
              `exp: ${lastExport}`
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
        const path = flags.path as string | undefined;

        if (!space) {
          logger.logInfo(style('❌ Space name is required (--space)', ['red']));
          return;
        }

        if (!path) {
          logger.logInfo(style('❌ Path is required (--path)', ['red']));
          return;
        }

        // Verify space exists
        const spaceData = store.getSpace(space);
        if (!spaceData) {
          logger.logInfo(style(`❌ Space "${space}" not found`, ['red']));
          return;
        }

        // Get existing config or create new
        const existing = store.getSyncConfig(space);
        const now = new Date().toISOString();

        store.setSyncConfig(space, {
          enabled: true,
          basePath: path,
          conflictResolution: existing?.conflictResolution ?? 'db-wins',
          lastExportedAt: now,
        });

        // Export all memories to the path
        const exportResult = await store.exportSpaceToFiles(space, path);

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
            ` — ${count} memories exported to ${path}`
        );
      },
    },

    // ── sync disable ──
    {
      matches: args => DISABLE_PARSER.matches(args),
      execute: async (args, store, logger) => {
        const flags = DISABLE_PARSER.getFlags(args);
        const space = flags.space as string | undefined;

        if (!space) {
          logger.logInfo(style('❌ Space name is required (--space)', ['red']));
          return;
        }

        // Verify config exists
        const config = store.getSyncConfig(space);
        if (!config) {
          logger.logInfo(style(`❌ No sync config found for "${space}"`, ['red']));
          return;
        }

        store.setSyncConfig(space, { enabled: false });

        logger.logInfo(
          style(`✅ Autosync disabled for ${space}`, ['green']) +
            ' — files preserved at ' +
            config.basePath
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

        // Verify config exists
        const config = store.getSyncConfig(space);
        if (!config) {
          logger.logInfo(
            style(`❌ No sync config found for "${space}". Run "sync enable" first.`, ['red'])
          );
          return;
        }

        const basePath = config.basePath;
        const resolution = config.conflictResolution;

        // Step 1: Export DB → FS
        const exportResult = await store.exportSpaceToFiles(space, basePath);

        // Step 2: Import FS → DB (detect external changes)
        const importResult = await importFromDirectory(store, space, basePath, resolution);

        // Update timestamps
        const now = new Date().toISOString();
        store.setSyncConfig(space, { lastExportedAt: now, lastImportedAt: now });

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
        const path = flags.path as string | undefined;

        if (!space) {
          logger.logInfo(style('❌ Space name is required (--space)', ['red']));
          return;
        }

        if (!path) {
          logger.logInfo(style('❌ Path is required (--path)', ['red']));
          return;
        }

        // Verify space exists
        const spaceData = store.getSpace(space);
        if (!spaceData) {
          logger.logInfo(style(`❌ Space "${space}" not found`, ['red']));
          return;
        }

        // Export
        const result = await store.exportSpaceToFiles(space, path);

        if (result.failed > 0) {
          logger.logInfo(
            style(`❌ Exported ${result.exported} files, ${result.failed} failed:`, ['red'])
          );
          for (const err of result.errors) {
            logger.logInfo(style(`   - ${err}`, ['red']));
          }
        } else {
          logger.logInfo(style(`✅ Exported ${result.exported} memories to ${path}`, ['green']));
        }
      },
    },

    // ── sync import ──
    {
      matches: args => IMPORT_PARSER.matches(args),
      execute: async (args, store, logger) => {
        const flags = IMPORT_PARSER.getFlags(args);
        const space = flags.space as string | undefined;
        const path = flags.path as string | undefined;

        if (!space) {
          logger.logInfo(style('❌ Space name is required (--space)', ['red']));
          return;
        }

        if (!path) {
          logger.logInfo(style('❌ Path is required (--path)', ['red']));
          return;
        }

        // Verify space exists
        const spaceData = store.getSpace(space);
        if (!spaceData) {
          logger.logInfo(style(`❌ Space "${space}" not found`, ['red']));
          return;
        }

        // Get conflict resolution from config (or use default)
        const config = store.getSyncConfig(space);
        const resolution = config?.conflictResolution ?? 'db-wins';

        const result = await importFromDirectory(store, space, path, resolution);

        // Update last imported timestamp if we have a config
        if (config) {
          store.setSyncConfig(space, { lastImportedAt: new Date().toISOString() });
        }

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
            style(`✅ Imported ${result.imported} new, ${result.updated} updated from ${path}`, [
              'green',
            ])
          );
        }
      },
    },

    // ── sync conflict ──
    {
      matches: args => CONFLICT_PARSER.matches(args),
      execute: async (args, store, logger) => {
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

        // Verify config exists
        const config = store.getSyncConfig(space);
        if (!config) {
          logger.logInfo(
            style(`❌ No sync config found for "${space}". Run "sync enable" first.`, ['red'])
          );
          return;
        }

        store.setSyncConfig(space, { conflictResolution: strategy as ConflictResolution });

        logger.logInfo(
          style(`✅ Conflict resolution set to "${strategy}" for ${space}`, ['green'])
        );
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

        // Verify config exists and is enabled
        const config = store.getSyncConfig(space);
        if (!config) {
          logger.logInfo(
            style(`❌ No sync config found for "${space}". Run "sync enable" first.`, ['red'])
          );
          return;
        }
        if (!config.enabled) {
          logger.logInfo(
            style(`❌ Sync is disabled for "${space}". Run "sync enable" first.`, ['red'])
          );
          return;
        }

        const syncDir = config.basePath;
        if (!existsSync(syncDir)) {
          logger.logInfo(style(`❌ Sync directory does not exist: ${syncDir}`, ['red']));
          return;
        }

        const autoSync = new AutoSyncService(store);

        await autoSync.startWatching(space);

        logger.logInfo(style(`👁 Watching ${syncDir} for changes...`, ['cyan']));
        logger.logInfo('Press Ctrl+C to stop.\n');

        // Log when events are processed
        // Since we can't easily intercept, we just show running status
        // The events are processed by AutoSyncService.handleFileEvent
        // which logs via console.error internally. We show a status line periodically.
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
