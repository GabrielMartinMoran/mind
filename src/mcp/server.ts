import { randomUUID } from 'node:crypto';

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  isInitializeRequest,
} from '@modelcontextprotocol/sdk/types.js';

import { createLogEntry } from '../helpers/logger';
import type { MindStore } from '../store/mind-store';
import { AutoSyncService as _AutoSyncService } from '../sync';

import { zodToJsonSchema } from './helpers/json-schema';
import type { ToolDefinition } from './tool-types';
import { createCheckpointTools } from './tools/checkpoint';
import { createLinkTools } from './tools/links';
import { createMemoryTools } from './tools/memories';
import { createSpaceTools } from './tools/spaces';
import { createStatusTools } from './tools/status';
import { createSystemTools } from './tools/system';

function createMcpServer(store: MindStore): Server {
  const server = new Server(
    {
      name: 'mind-mcp-server',
      version: '1.0.0',
    },
    {
      capabilities: {
        tools: {},
      },
    }
  );

  const allTools: Record<string, ToolDefinition> = {
    ...createSpaceTools(store),
    ...createMemoryTools(store),
    ...createLinkTools(store),
    ...createStatusTools(store),
    ...createCheckpointTools(store),
    ...createSystemTools(),
  };

  const logEntry = createLogEntry(store);

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    return {
      tools: Object.entries(allTools).map(([name, tool]) => ({
        name,
        description: tool.description
          ? `${tool.description}\n\nSee system_instructions for full mind usage guidelines.`
          : `Call system_instructions first to get full mind usage guidelines.\n\nTool: ${name}`,
        inputSchema: tool.schema
          ? zodToJsonSchema(tool.schema)
          : { type: 'object', properties: {} },
        annotations: tool.annotations,
      })),
    };
  });

  server.setRequestHandler(CallToolRequestSchema, async request => {
    const { name, arguments: args } = request.params;
    const tool = allTools[name];

    if (!tool) {
      throw new Error(`Unknown tool: ${name}`);
    }

    const startTime = Date.now();
    let logLevel: 'info' | 'warn' | 'error' = 'info';
    let errorMessage: string | undefined;
    let outputData: Record<string, unknown> | undefined;

    try {
      const result = await tool.handler(args);
      const structuredContent =
        result?.structuredContent ??
        (result && typeof result === 'object'
          ? Object.fromEntries(
              Object.entries(result).filter(
                ([key]) => key !== 'content' && key !== 'isError' && key !== 'meta'
              )
            )
          : undefined);

      outputData = structuredContent;

      return {
        content: result.content ?? [{ type: 'text', text: 'OK' }],
        ...(structuredContent && Object.keys(structuredContent).length > 0
          ? { structuredContent }
          : {}),
        isError: false,
      };
    } catch (error: any) {
      logLevel = 'error';
      errorMessage = error.message;
      return {
        content: [{ type: 'text', text: `Error: ${error.message}` }],
        isError: true,
      };
    } finally {
      const durationMs = Date.now() - startTime;
      logEntry({
        source: 'mcp',
        operation: name,
        level: logLevel,
        inputData: args,
        outputData,
        errorMessage,
        durationMs,
        callerInfo: {},
      });
    }
  });

  return server;
}

export { zodToJsonSchema } from './helpers/json-schema';

// ── Autosync watchers ─────────────────────────────────────────────────────────

export async function startAutosyncWatchers(store: MindStore, projectRoot?: string): Promise<void> {
  const { startAutosyncWatchers: startWatchers } = await import('../sync/auto-sync-service');
  await startWatchers(store, projectRoot ?? process.cwd());
}

export async function startMcpServer(store: MindStore, projectRoot?: string): Promise<void> {
  const server = createMcpServer(store);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('Mind MCP server running on stdio');

  // Resolve project root: explicit parameter > MIND_SYNC_ROOT env > cwd
  const resolvedRoot = projectRoot ?? process.env.MIND_SYNC_ROOT ?? process.cwd();

  // Start autosync watchers for all enabled spaces
  setImmediate(() => startAutosyncWatchers(store, resolvedRoot));

  await new Promise(() => {}); // keep alive
}

type SessionEntry = {
  server: Server;
  transport: WebStandardStreamableHTTPServerTransport;
};

function jsonRpcSessionError(status: number, message: string): Response {
  return new Response(
    JSON.stringify({
      jsonrpc: '2.0',
      error: { code: -32000, message },
      id: null,
    }),
    {
      status,
      headers: { 'Content-Type': 'application/json' },
    }
  );
}

export async function startMcpHttpServer(
  store: MindStore,
  port: number = 7438,
  projectRoot?: string
): Promise<void> {
  const sessions = new Map<string, SessionEntry>();
  const mcpPort = Number(port || process.env.MCP_PORT || 7438);
  const idleTimeout = Number(process.env.MIND_MCP_IDLE_TIMEOUT ?? 120);

  Bun.serve({
    port: mcpPort,
    idleTimeout,
    async fetch(req: Request): Promise<Response> {
      const url = new URL(req.url);

      if (url.pathname === '/health' && req.method === 'GET') {
        return new Response(
          JSON.stringify({ status: 'ok', service: 'mind-mcp', version: '1.0.0' }),
          {
            headers: { 'Content-Type': 'application/json' },
          }
        );
      }

      if (url.pathname !== '/mcp') {
        return new Response('Not Found', { status: 404 });
      }

      if (req.method === 'POST') {
        let body: unknown;
        try {
          body = await req.json();
        } catch {
          return jsonRpcSessionError(400, 'Invalid JSON body');
        }

        const sessionId = req.headers.get('mcp-session-id') ?? undefined;

        if (sessionId && sessions.has(sessionId)) {
          const current = sessions.get(sessionId)!;
          return current.transport.handleRequest(req, { parsedBody: body });
        }

        if (!sessionId && isInitializeRequest(body)) {
          const server = createMcpServer(store);
          let transport: WebStandardStreamableHTTPServerTransport;

          transport = new WebStandardStreamableHTTPServerTransport({
            sessionIdGenerator: () => randomUUID(),
            onsessioninitialized: id => {
              sessions.set(id, { server, transport });
            },
          });

          transport.onclose = () => {
            const id = transport.sessionId;
            if (id) {
              sessions.delete(id);
            }
            server.close().catch(() => {});
          };

          await server.connect(transport);
          return transport.handleRequest(req, { parsedBody: body });
        }

        return jsonRpcSessionError(400, 'Invalid or missing MCP session');
      }

      if (req.method === 'GET' || req.method === 'DELETE') {
        const sessionId = req.headers.get('mcp-session-id') ?? undefined;
        if (!sessionId || !sessions.has(sessionId)) {
          return jsonRpcSessionError(400, 'Invalid or missing MCP session');
        }
        const current = sessions.get(sessionId)!;
        return current.transport.handleRequest(req);
      }

      return jsonRpcSessionError(405, 'Method not allowed');
    },
  });

  console.error(`Mind MCP HTTP server running on http://localhost:${mcpPort}/mcp`);

  // Resolve project root: explicit parameter > MIND_SYNC_ROOT env > cwd
  const resolvedRoot = projectRoot ?? process.env.MIND_SYNC_ROOT ?? process.cwd();

  // Start autosync watchers for all enabled spaces
  setImmediate(() => startAutosyncWatchers(store, resolvedRoot));
}
