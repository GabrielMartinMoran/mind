import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { describe, expect, test } from 'bun:test';

import { renderSkillActivation } from '../src/cli/skill-activation';

describe('MCP initialize instructions', () => {
  test('the stdio handshake exposes the brief skill activation', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'mind-mcp-instructions-'));
    const dbPath = join(tempDir, 'mind.db');
    const originalDbPath = process.env.MIND_DB_PATH;

    // Use absolute paths so the spawned server resolves modules regardless of cwd.
    const testDir = fileURLToPath(new URL('.', import.meta.url));
    const mindPath = join(testDir, '..', 'src', 'mind.ts');

    let client: Client | undefined;
    let transport: StdioClientTransport | undefined;

    try {
      process.env.MIND_DB_PATH = dbPath;
      transport = new StdioClientTransport({
        command: process.execPath,
        args: ['run', mindPath, 'mcp'],
        env: {
          ...process.env,
          MIND_DB_PATH: dbPath,
          MIND_SYNC_ROOT: tempDir,
        },
      });
      client = new Client({ name: 'mind-instructions-test', version: '1.0.0' });

      await client.connect(transport);

      const instructions = client.getInstructions();

      expect(instructions).toBe(renderSkillActivation());
      expect(instructions).toContain('mind-management');
      expect(instructions).toContain('system_instructions');
      expect(instructions).not.toContain('## ORIENT');
      expect(instructions).not.toContain('<!-- mind-cognitive-protocol:body -->');
    } finally {
      if (client) {
        await client.close().catch(() => {});
      }
      if (transport) {
        await transport.close().catch(() => {});
      }

      if (originalDbPath === undefined) {
        delete process.env.MIND_DB_PATH;
      } else {
        process.env.MIND_DB_PATH = originalDbPath;
      }

      await rm(tempDir, { recursive: true, force: true });
    }
  }, 20000);
});
