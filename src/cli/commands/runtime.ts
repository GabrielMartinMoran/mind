import { runApiServer } from '../../api/server';
import { startMcpHttpServer, startMcpServer } from '../../mcp/server';
import type { MindStore } from '../../store/mind-store';
import { ArgParser } from '../arg-parser';
import { getSupportedAgents, type SupportedAgent } from '../capabilities';
import { runUpdateCommand } from '../self-update';
import {
  listAgents,
  runSetup,
  runSetupAll,
  runSetupRefresh,
  startMcpDetached,
  startServeDetached,
  statusServers,
  stopMcp,
  stopServe,
} from '../setup';

import type { CommandGroup } from './types';

const p = ArgParser.param.bind(ArgParser);

const SERVER_STATUS = new ArgParser(['server-status'], 'Shows server status (MCP and web)');

const MCP_STDIO = new ArgParser(['mcp'], 'Starts MCP server (stdio mode)');
const MCP_START = new ArgParser(['mcp', 'start'], 'Starts MCP server', [
  { name: 'detached', hasValue: false, description: 'run in background' },
  { name: 'port', hasValue: true, description: 'custom port (HTTP mode)' },
  { name: 'http', hasValue: false, description: 'run MCP over HTTP' },
]);
const MCP_STOP = new ArgParser(['mcp', 'stop'], 'Stops MCP server');

const SERVE_START = new ArgParser(['serve|server|web', 'start'], 'Starts web HTTP server', [
  { name: 'detached', hasValue: false, description: 'run in background' },
  { name: 'port', hasValue: true, description: 'custom port' },
]);
const SERVE_STOP = new ArgParser(['serve|server|web', 'stop'], 'Stops web HTTP server');

const SETUP = new ArgParser(['setup|install'], 'Configures Mind for all supported agents');
const SETUP_COMPATIBILITY = new ArgParser(
  ['setup|install', 'compatibility'],
  'Shows agent integration compatibility'
);
const SETUP_REFRESH = new ArgParser(
  ['setup|install', 'refresh'],
  'Refreshes detected Mind-managed agent integrations',
  [
    { name: 'dry-run', hasValue: false, description: 'show what would be refreshed' },
    { name: 'all', hasValue: false, description: 'refresh all supported agents' },
    { name: 'agent', hasValue: true, description: 'refresh one agent only' },
  ]
);
const SETUP_AGENT = new ArgParser(
  ['setup|install', p('agent')],
  `Configures Mind for one agent.\n\tSupported agents: ${getSupportedAgents().join(', ')}`
);

const UPDATE = new ArgParser(['update'], 'Updates mind from GitHub releases', [
  { name: 'check', hasValue: false, description: 'check if update is available' },
  { name: 'version', hasValue: true, description: 'install a specific release tag' },
  { name: 'repo', hasValue: true, description: 'override GitHub repo' },
  {
    name: 'no-refresh-integrations',
    hasValue: false,
    description: 'skip detected integration refresh after install',
  },
]);

async function runMcpForeground(
  flags: Record<string, string | boolean>,
  store: MindStore
): Promise<void> {
  const http = !!flags.http;
  const port = flags.port ? Number(flags.port) : Number(process.env.MCP_PORT ?? 7438);

  if (http) {
    await startMcpHttpServer(store, port);
    await new Promise(() => {});
    return;
  }

  await startMcpServer(store);
  await new Promise(() => {});
}

export const runtimeGroup: CommandGroup = {
  name: 'Server',
  helpEntries: [
    SERVER_STATUS,
    MCP_STDIO,
    MCP_START,
    MCP_STOP,
    SERVE_START,
    SERVE_STOP,
    SETUP,
    SETUP_COMPATIBILITY,
    SETUP_REFRESH,
    SETUP_AGENT,
    UPDATE,
  ],
  commands: [
    {
      matches: args => SERVER_STATUS.matches(args),
      execute: async () => {
        await statusServers();
      },
    },
    {
      matches: args => MCP_START.matches(args),
      execute: async (args, store) => {
        const flags = MCP_START.getFlags(args);
        if (flags.detached) {
          await startMcpDetached();
          return;
        }
        await runMcpForeground(flags, store);
      },
    },
    {
      matches: args => MCP_STOP.matches(args),
      execute: async () => {
        await stopMcp();
      },
    },
    {
      matches: args => MCP_STDIO.matches(args),
      execute: async (_args, store) => {
        await runMcpForeground({}, store);
      },
    },
    {
      matches: args => SERVE_START.matches(args),
      execute: async (args, store) => {
        const flags = SERVE_START.getFlags(args);
        const port = flags.port ? Number(flags.port) : undefined;
        if (flags.detached) {
          await startServeDetached(port);
          return;
        }
        await runApiServer(port, store);
      },
    },
    {
      matches: args => SERVE_STOP.matches(args),
      execute: async () => {
        await stopServe();
      },
    },
    {
      matches: args =>
        SETUP_REFRESH.matches(args) && SETUP_REFRESH.getPositionalArgs(args)[1] === 'refresh',
      execute: async args => {
        const flags = SETUP_REFRESH.getFlags(args);
        await runSetupRefresh({
          mode: flags.all ? 'all' : 'detected',
          agent: typeof flags.agent === 'string' ? (flags.agent as SupportedAgent) : undefined,
          dryRun: !!flags['dry-run'],
        });
      },
    },
    {
      matches: args =>
        SETUP_COMPATIBILITY.matches(args) &&
        SETUP_COMPATIBILITY.getPositionalArgs(args)[1] === 'compatibility',
      execute: async () => {
        listAgents();
      },
    },
    {
      matches: args => SETUP_AGENT.matches(args),
      execute: async args => {
        const { agent } = SETUP_AGENT.getParams(args);
        await runSetup(agent);
      },
    },
    {
      matches: args => SETUP.matches(args),
      execute: async () => {
        await runSetupAll();
      },
    },
    {
      matches: args => UPDATE.matches(args),
      execute: async args => {
        await runUpdateCommand(args.slice(1));
      },
    },
  ],
};
