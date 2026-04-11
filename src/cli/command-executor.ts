import { renderCommands } from '../helpers/format';
import type { Logger } from '../helpers/logger';
import { createLogEntry } from '../helpers/logger';
import { style } from '../helpers/style';
import type { MindStore } from '../store/mind-store';

import { ALL_GROUPS, SERVER_GROUP_HELP } from './commands';

const HELP_ALIASES = new Set(['help', 'h']);

export async function executeCommand(
  args: string[],
  store: MindStore,
  logger: Logger
): Promise<void> {
  if (args.length === 0) {
    throw new Error('No arguments provided. Run mind help for usage.');
  }

  if (HELP_ALIASES.has(args[0]!)) {
    printHelp(logger);
    return;
  }

  const logEntry = createLogEntry(store);
  let matchedCommand: any = null;

  for (const group of ALL_GROUPS) {
    for (const command of group.commands) {
      if (command.matches(args)) {
        matchedCommand = command;
        break;
      }
    }
    if (matchedCommand) break;
  }

  if (!matchedCommand) {
    throw new Error(`Unknown command "${args[0]}". Run mind help for the list of valid commands.`);
  }

  // CLI logging middleware
  const operation = args[0]!;
  const startTime = Date.now();
  let logLevel: 'info' | 'warn' | 'error' = 'info';
  let errorMessage: string | undefined;
  let outputData: Record<string, unknown> | undefined;

  try {
    await matchedCommand.execute(args, store, logger);
    // Capture output if available (would need to modify command interface to return result)
    logLevel = 'info';
  } catch (e: any) {
    logLevel = 'error';
    errorMessage = e.message;
    throw e;
  } finally {
    const durationMs = Date.now() - startTime;
    logEntry({
      source: 'cli',
      operation,
      level: logLevel,
      inputData: { args },
      outputData,
      errorMessage,
      durationMs,
    });
  }
}

function printHelp(logger: Logger): void {
  logger.logInfo(style('🧠 mind — long-term memory for agents and humans', ['bold']));

  const sections = [
    'Spaces',
    'Memories',
    'Tiers',
    'Links',
    'Search',
    'Status',
    'Tags',
    'Checkpoint',
    'Sync',
  ];
  for (const name of sections) {
    const group = ALL_GROUPS.find(g => g.name === name);
    if (!group) continue;
    logger.logInfo('');
    logger.logInfo(style(`${group.name}:`, ['bold', 'magenta']));
    renderCommands(group.helpEntries, logger);
  }

  logger.logInfo('');
  logger.logInfo(style('Server:', ['bold', 'magenta']));
  renderCommands(SERVER_GROUP_HELP, logger);

  logger.logInfo('');
  logger.logInfo(style('Other:', ['bold', 'magenta']));
  const guide = ALL_GROUPS.find(g => g.name === 'Guide');
  const migration = ALL_GROUPS.find(g => g.name === 'Migration');
  renderCommands([...(guide?.helpEntries ?? []), ...(migration?.helpEntries ?? [])], logger);
}
