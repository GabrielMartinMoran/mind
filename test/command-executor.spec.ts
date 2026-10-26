import { describe, expect, test, afterEach } from 'bun:test';

import { executeCommand } from '../src/cli/command-executor';
import { searchGroup } from '../src/cli/commands/search';
import { style } from '../src/helpers/style';
import type { MindStore } from '../src/store/mind-store';
import { EMPTY_SEARCH_QUERY_MESSAGE } from '../src/store/shared/search-query-error';

import { mockedLogger } from './mocks/mocked-logger';
import { createTestStore } from './mocks/test-store';

const ANSI_PATTERN = /\u001b\[[0-9;]*m/g;

function stripAnsi(value: string): string {
  return value.replace(ANSI_PATTERN, '');
}

let store: MindStore & { cleanup: () => void };

afterEach(() => {
  store?.cleanup();
});

describe('Command Executor — Basics', () => {
  test('should show help', () => {
    store = createTestStore();
    const logger = mockedLogger();
    executeCommand(['help'], store, logger);
    const logs = logger.getLogs();
    expect(logs.some(l => l.message.includes('mind'))).toBe(true);
  });

  test('should throw for empty args', () => {
    store = createTestStore();
    const logger = mockedLogger();
    expect(() => executeCommand([], store, logger)).toThrow('No arguments provided');
  });

  test('should throw for unknown command', () => {
    store = createTestStore();
    const logger = mockedLogger();
    expect(() => executeCommand(['banana'], store, logger)).toThrow('Unknown command');
  });

  test('should reject unknown runtime subcommands', () => {
    store = createTestStore();
    const logger = mockedLogger();
    expect(() => executeCommand(['mcp', 'help'], store, logger)).toThrow('Unknown command');
    expect(() => executeCommand(['serve', 'help'], store, logger)).toThrow('Unknown command');
  });
});

describe('Command Executor — Spaces', () => {
  test('should create a space', () => {
    store = createTestStore();
    const logger = mockedLogger();
    executeCommand(['create', 'test-space', 'A test space'], store, logger);

    const space = store.getSpace('test-space');
    expect(space).not.toBeNull();
    expect(space!.description).toBe('A test space');
    expect(logger.getLogs().some(l => l.message.includes('created'))).toBe(true);
  });

  test('should create a space with tags', () => {
    store = createTestStore();
    const logger = mockedLogger();
    executeCommand(
      ['create', 'test-space', 'A test space', '--tags', 'project,dev'],
      store,
      logger
    );

    const space = store.getSpace('test-space');
    expect(space!.tags).toContain('project');
    expect(space!.tags).toContain('dev');
  });

  test('should list spaces', () => {
    store = createTestStore();
    const logger = mockedLogger();
    store.createSpace('space1', 'Space 1', ['test']);
    store.createSpace('space2', 'Space 2', ['test']);

    executeCommand(['list'], store, logger);
    const logs = logger.getLogs();
    expect(logs.some(l => l.message.includes('space1'))).toBe(true);
    expect(logs.some(l => l.message.includes('space2'))).toBe(true);
  });

  test('should delete a space', () => {
    store = createTestStore();
    const logger = mockedLogger();
    store.createSpace('test', 'Test', ['test']);
    executeCommand(['delete', 'test'], store, logger);
    expect(store.getSpace('test')).toBeNull();
  });

  test('should rename a space', () => {
    store = createTestStore();
    const logger = mockedLogger();
    store.createSpace('old', 'Old', ['test']);
    executeCommand(['rename', 'old', 'new'], store, logger);
    expect(store.getSpace('old')).toBeNull();
    expect(store.getSpace('new')).not.toBeNull();
  });

  test('should describe a space', () => {
    store = createTestStore();
    const logger = mockedLogger();
    store.createSpace('test', 'Old desc', ['test']);
    executeCommand(['describe', 'test', 'New desc'], store, logger);
    expect(store.getSpace('test')!.description).toBe('New desc');
  });

  test('should tag and untag a space', () => {
    store = createTestStore();
    const logger = mockedLogger();
    store.createSpace('test', 'Test', ['test']);

    executeCommand(['tag', 'test', 'project'], store, logger);
    expect(store.getSpace('test')!.tags).toContain('project');

    executeCommand(['untag', 'test', 'project'], store, logger);
    expect(store.getSpace('test')!.tags).not.toContain('project');
  });

  test('should update space to hidden', () => {
    store = createTestStore();
    const logger = mockedLogger();
    store.createSpace('test', 'Test', ['test']);

    executeCommand(['update', 'test', '--hidden'], store, logger);

    const space = store.getSpace('test');
    expect(space!.hidden).toBe(true);

    // Should not appear in regular list
    const list = store.listSpaces();
    expect(list.length).toBe(0);

    // Should appear with hidden flag
    const listHidden = store.listSpaces({ includeHidden: true });
    expect(listHidden.length).toBe(1);
  });

  test('should update hidden space to visible', () => {
    store = createTestStore();
    const logger = mockedLogger();
    store.createSpace('test', 'Test', ['test']);
    store.updateSpace('test', { hidden: true });

    executeCommand(['update', 'test', '--no-hidden'], store, logger);

    const space = store.getSpace('test');
    expect(space!.hidden).toBe(false);

    // Should appear in regular list
    const list = store.listSpaces();
    expect(list.length).toBe(1);
  });

  test('should list hidden spaces with --hidden flag', () => {
    store = createTestStore();
    const logger = mockedLogger();
    store.createSpace('visible', 'Visible', ['test']);
    store.createSpace('hidden', 'Hidden', ['test']);
    store.updateSpace('hidden', { hidden: true });

    executeCommand(['list', '--hidden'], store, logger);

    const logs = logger.getLogs();
    expect(logs.some(l => l.message.includes('visible'))).toBe(true);
    expect(logs.some(l => l.message.includes('hidden'))).toBe(true);
  });
});

describe('Command Executor — Memories', () => {
  test('should add a memory', () => {
    store = createTestStore();
    const logger = mockedLogger();
    store.createSpace('test', 'Test', ['test']);
    executeCommand(['add', 'test', 'auth', 'JWT auth flow'], store, logger);

    const mem = store.getMemory('test', 'auth');
    expect(mem).not.toBeNull();
    expect(mem!.content).toBe('JWT auth flow');
  });

  test('should add a memory with tags and tier', () => {
    store = createTestStore();
    const logger = mockedLogger();
    store.createSpace('test', 'Test', ['test']);
    executeCommand(
      ['add', 'test', 'auth', 'JWT auth', '--tags', 'backend,security', '--tier', '1'],
      store,
      logger
    );

    const mem = store.getMemory('test', 'auth');
    expect(mem!.tier).toBe(1);
    expect(mem!.tags).toContain('backend');
  });

  test('should read a memory and record access', () => {
    store = createTestStore();
    const logger = mockedLogger();
    store.createSpace('test', 'Test', ['test']);
    store.addMemory('test', 'auth', 'JWT auth', { tags: ['test'] });

    executeCommand(['read', 'test', 'auth'], store, logger);

    const mem = store.getMemory('test', 'auth');
    expect(mem!.access_count).toBe(1);
    expect(logger.getLogs().some(l => l.message.includes('auth'))).toBe(true);
  });

  test('should edit a memory', () => {
    store = createTestStore();
    const logger = mockedLogger();
    store.createSpace('test', 'Test', ['test']);
    store.addMemory('test', 'auth', 'Old content', { tags: ['test'] });

    executeCommand(['edit', 'test', 'auth', 'New content'], store, logger);
    expect(store.getMemory('test', 'auth')!.content).toBe('New content');
  });

  test('should remove a memory by name', () => {
    store = createTestStore();
    const logger = mockedLogger();
    store.createSpace('test', 'Test', ['test']);
    store.addMemory('test', 'auth', 'content', { tags: ['test'] });

    executeCommand(['remove', 'test', 'auth'], store, logger);
    expect(store.getMemory('test', 'auth')).toBeNull();
  });

  test('should list memories of a space', () => {
    store = createTestStore();
    const logger = mockedLogger();
    store.createSpace('test', 'Test', ['test']);
    store.addMemory('test', 'mem1', 'content', { tier: 1, tags: ['test'] });
    store.addMemory('test', 'mem2', 'content', { tier: 2, tags: ['test'] });

    executeCommand(['list', 'test'], store, logger);
    const logs = logger.getLogs();
    expect(logs.some(l => l.message.includes('mem1'))).toBe(true);
    expect(logs.some(l => l.message.includes('mem2'))).toBe(true);
  });

  test('should tag and untag a memory', () => {
    store = createTestStore();
    const logger = mockedLogger();
    store.createSpace('test', 'Test', ['test']);
    store.addMemory('test', 'auth', 'content', { tags: ['test'] });

    executeCommand(['tag', 'test', 'auth', 'important'], store, logger);
    expect(store.getMemory('test', 'auth')!.tags).toContain('important');

    executeCommand(['untag', 'test', 'auth', 'important'], store, logger);
    expect(store.getMemory('test', 'auth')!.tags).not.toContain('important');
  });
});

describe('Command Executor — Tiers', () => {
  test('should promote a memory', () => {
    store = createTestStore();
    const logger = mockedLogger();
    store.createSpace('test', 'Test', ['test']);
    store.addMemory('test', 'mem', 'content', { tier: 3, tags: ['test'] });

    executeCommand(['promote', 'test', 'mem'], store, logger);
    expect(store.getMemory('test', 'mem')!.tier).toBe(2);
  });

  test('should demote a memory', () => {
    store = createTestStore();
    const logger = mockedLogger();
    store.createSpace('test', 'Test', ['test']);
    store.addMemory('test', 'mem', 'content', { tier: 1, tags: ['test'] });

    executeCommand(['demote', 'test', 'mem'], store, logger);
    expect(store.getMemory('test', 'mem')!.tier).toBe(2);
  });

  test('should pin a memory', () => {
    store = createTestStore();
    const logger = mockedLogger();
    store.createSpace('test', 'Test', ['test']);
    store.addMemory('test', 'mem', 'content', { tags: ['test'] });

    executeCommand(['pin', 'test', 'mem'], store, logger);
    expect(store.getMemory('test', 'mem')!.pinned).toBe(true);
  });

  test('should unpin a memory', async () => {
    store = createTestStore();
    const logger = mockedLogger();
    store.createSpace('test', 'Test', ['test']);
    const mem = await store.addMemory('test', 'mem', 'content', { tags: ['test'] });
    store.pin(mem.id);

    executeCommand(['unpin', 'test', 'mem'], store, logger);
    expect(store.getMemory('test', 'mem')!.pinned).toBe(false);
  });
});

describe('Command Executor — Links', () => {
  test('should link two memories', () => {
    store = createTestStore();
    const logger = mockedLogger();
    store.createSpace('test', 'Test', ['test']);
    store.addMemory('test', 'mem1', 'content', { tags: ['test'] });
    store.addMemory('test', 'mem2', 'content', { tags: ['test'] });

    executeCommand(['link', 'test/mem1', 'test/mem2', '--label', 'depends-on'], store, logger);

    const mem1 = store.getMemory('test', 'mem1');
    const links = store.getLinks(mem1!.id);
    expect(links.length).toBe(1);
    expect(links[0]!.label).toBe('depends-on');
  });

  test('should show links', async () => {
    store = createTestStore();
    const logger = mockedLogger();
    store.createSpace('test', 'Test', ['test']);
    const mem1 = await store.addMemory('test', 'mem1', 'content', { tags: ['test'] });
    const mem2 = await store.addMemory('test', 'mem2', 'content', { tags: ['test'] });
    store.link(mem1.id, mem2.id, 'related');

    executeCommand(['links', 'test', 'mem1'], store, logger);
    const logs = logger.getLogs();
    expect(logs.some(l => l.message.includes('mem2'))).toBe(true);
  });

  test('should unlink memories', async () => {
    store = createTestStore();
    const logger = mockedLogger();
    store.createSpace('test', 'Test', ['test']);
    const mem1 = await store.addMemory('test', 'mem1', 'content', { tags: ['test'] });
    const mem2 = await store.addMemory('test', 'mem2', 'content', { tags: ['test'] });
    store.link(mem1.id, mem2.id);

    executeCommand(['unlink', 'test/mem1', 'test/mem2'], store, logger);
    const links = store.getLinks(mem1.id);
    expect(links.length).toBe(0);
  });
});

describe('Command Executor — Search', () => {
  test('should search memories', async () => {
    store = createTestStore();
    const logger = mockedLogger();
    store.createSpace('test', 'Test', ['test']);
    store.addMemory('test', 'auth', 'JWT authentication with refresh tokens', { tags: ['test'] });
    store.addMemory('test', 'db', 'PostgreSQL database schema', { tags: ['test'] });

    await executeCommand(['search', 'authentication'], store, logger);
    const logs = logger.getLogs();
    expect(logs.some(l => l.message.includes('auth'))).toBe(true);
    expect(logs.some(l => l.message.includes('db'))).toBe(false);
  });

  test('should not show content by default', async () => {
    store = createTestStore();
    const logger = mockedLogger();
    store.createSpace('test', 'Test', ['test']);
    store.addMemory('test', 'auth', 'JWT authentication with refresh tokens', { tags: ['test'] });

    await executeCommand(['search', 'authentication'], store, logger);
    const logs = logger.getLogs();
    expect(logs.some(l => l.message.includes('JWT'))).toBe(false);
  });

  test('should show content with --detail', async () => {
    store = createTestStore();
    const logger = mockedLogger();
    store.createSpace('test', 'Test', ['test']);
    store.addMemory('test', 'auth', 'JWT authentication with refresh tokens', { tags: ['test'] });

    await executeCommand(['search', 'authentication', '--detail'], store, logger);
    const logs = logger.getLogs();
    expect(logs.some(l => l.message.includes('JWT'))).toBe(true);
  });

  test('should support prefix wildcard search', async () => {
    store = createTestStore();
    const logger = mockedLogger();
    store.createSpace('test', 'Test', ['test']);
    store.addMemory('test', 'auth', 'JWT authentication with refresh tokens', { tags: ['test'] });

    await executeCommand(['search', 'auth*'], store, logger);
    const logs = logger.getLogs();
    expect(logs.some(l => l.message.includes('auth'))).toBe(true);
  });

  test('should search with space filter', async () => {
    store = createTestStore();
    const logger = mockedLogger();
    store.createSpace('proj-a', 'A', ['test']);
    store.createSpace('proj-b', 'B', ['test']);
    store.addMemory('proj-a', 'auth', 'authentication', { tags: ['test'] });
    store.addMemory('proj-b', 'auth', 'authentication', { tags: ['test'] });

    await executeCommand(['search', 'authentication', '--space', 'proj-a'], store, logger);
    const logs = logger.getLogs();
    expect(logs.some(l => l.message.includes('proj-a'))).toBe(true);
  });

  test('should surface the shared validation error for an empty or stopword-only query', async () => {
    store = createTestStore();
    const logger = mockedLogger();
    store.createSpace('test', 'Test', ['test']);
    await store.addMemory('test', 'noise', 'the and for de la', { tags: ['test'] });

    for (const query of ['', '   ', 'the and for']) {
      await expect(executeCommand(['search', query], store, logger)).rejects.toThrow(
        EMPTY_SEARCH_QUERY_MESSAGE
      );
    }
  });

  test('should document quoting, uppercase operators, and validation recovery in search help', () => {
    const help = stripAnsi(searchGroup.helpEntries[0]!.getRendered());

    expect(help).toContain('quote it when it contains multiple words');
    expect(help).toContain('Only uppercase AND, OR, NOT are boolean operators');
    expect(help).toContain('add a specific topic, name, identifier, or code term');
    expect(help).toContain('list memories by metadata');
  });

  test('should query memories with metadata filters', async () => {
    store = createTestStore();
    const logger = mockedLogger();
    store.createSpace('proj-a', 'A', ['test']);
    store.createSpace('proj-b', 'B', ['test']);
    await store.addMemory('proj-a', 'auth', 'authentication', { tags: ['backend'], tier: 1 });
    await store.addMemory('proj-b', 'auth', 'authentication', { tags: ['backend'], tier: 1 });

    await executeCommand(
      ['query', '--space', 'proj-a', '--tag', 'backend', '--tier', '1'],
      store,
      logger
    );
    const logs = logger.getLogs();
    expect(logs.some(l => l.message.includes('proj-a') && l.message.includes('auth'))).toBe(true);
    expect(logs.some(l => l.message.includes('proj-b') && l.message.includes('auth'))).toBe(false);
  });

  test('should annotate each result with a confidence bucket marker', async () => {
    store = createTestStore();
    const logger = mockedLogger();
    store.createSpace('test', 'Test', ['test']);
    await store.addMemory('test', 'auth', 'JWT authentication with refresh tokens', {
      tags: ['test'],
    });

    await executeCommand(['search', 'authentication'], store, logger);
    const logs = logger.getLogs().map(l => stripAnsi(l.message));
    expect(logs.some(m => /\[(high|medium|low)\]/.test(m))).toBe(true);
    expect(logs.some(m => m.includes('[high]'))).toBe(true);
  });

  test('should default to 25 results and report the pre-limit total', async () => {
    store = createTestStore();
    const logger = mockedLogger();
    store.createSpace('test', 'Test', ['test']);
    for (let i = 0; i < 30; i++) {
      await store.addMemory('test', `m-${i}`, 'shared token content', { tags: ['test'] });
    }

    await executeCommand(['search', 'token'], store, logger);
    const logs = logger.getLogs().map(l => stripAnsi(l.message));
    const memoryLines = logs.filter(m => /^\s*\[.*\] \/ \[/.test(m));
    expect(logs.some(m => m.includes('🔍 30 result(s) for "token":'))).toBe(true);
    expect(memoryLines.length).toBe(25);
    expect(logs.some(m => m.includes('Pagination | limit: 25 | offset: 0 | next offset: 25'))).toBe(
      true
    );
  });

  test('should honour --limit and --offset', async () => {
    store = createTestStore();
    const logger = mockedLogger();
    store.createSpace('test', 'Test', ['test']);
    for (let i = 0; i < 5; i++) {
      await store.addMemory('test', `m-${i}`, 'shared token content', { tags: ['test'] });
    }

    await executeCommand(['search', 'token', '--limit', '2', '--offset', '1'], store, logger);
    const logs = logger.getLogs().map(l => stripAnsi(l.message));
    const memoryLines = logs.filter(m => /^\s*\[.*\] \/ \[/.test(m));
    expect(memoryLines.length).toBe(2);
    expect(logs.some(m => m.includes('Pagination | limit: 2 | offset: 1 | next offset: 3'))).toBe(
      true
    );
  });

  test('should clamp --limit to the 500 max page size', async () => {
    store = createTestStore();
    const logger = mockedLogger();
    store.createSpace('test', 'Test', ['test']);
    for (let i = 0; i < 501; i++) {
      await store.addMemory('test', `m-${i}`, 'shared token content', { tags: ['test'] });
    }

    await executeCommand(['search', 'token', '--limit', '1000'], store, logger);
    const logs = logger.getLogs().map(l => stripAnsi(l.message));
    const memoryLines = logs.filter(m => /^\s*\[.*\] \/ \[/.test(m));
    expect(logs.some(m => m.includes('🔍 501 result(s) for "token":'))).toBe(true);
    expect(memoryLines.length).toBe(500);
    expect(logs.some(m => m.includes('Pagination | limit: 500 | offset: 0'))).toBe(true);
  });

  test('should reject a non-positive --limit', async () => {
    store = createTestStore();
    const logger = mockedLogger();
    store.createSpace('test', 'Test', ['test']);
    await store.addMemory('test', 'auth', 'token content', { tags: ['test'] });

    await expect(
      executeCommand(['search', 'token', '--limit', '0'], store, logger)
    ).rejects.toThrow('--limit must be a positive number.');
  });

  test('should show pagination with next offset in query output', async () => {
    store = createTestStore();
    const logger = mockedLogger();
    store.createSpace('test', 'Test', ['test']);
    await store.addMemory('test', 'a', 'content', { tags: ['test'] });
    await store.addMemory('test', 'b', 'content', { tags: ['test'] });

    await executeCommand(
      ['query', '--space', 'test', '--limit', '1', '--offset', '0'],
      store,
      logger
    );
    const logs = logger.getLogs();
    expect(
      logs.some(l => l.message.includes('Pagination | limit: 1 | offset: 0 | next offset: 1'))
    ).toBe(true);
  });

  test('should show N/A next offset when query page is exhausted', async () => {
    store = createTestStore();
    const logger = mockedLogger();
    store.createSpace('test', 'Test', ['test']);
    await store.addMemory('test', 'a', 'content', { tags: ['test'] });

    await executeCommand(['query', '--space', 'test'], store, logger);
    const logs = logger.getLogs();
    expect(
      logs.some(l => l.message.includes('Pagination | limit: 25 | offset: 0 | next offset: N/A'))
    ).toBe(true);
  });
});

describe('Command Executor — Guide', () => {
  test('should show agent guide', () => {
    store = createTestStore();
    const logger = mockedLogger();
    executeCommand(['guide', 'agent'], store, logger);
    const logs = logger.getLogs();
    expect(logs.some(l => l.message.includes('Agent Guide'))).toBe(true);
  });

  test('should show human guide', () => {
    store = createTestStore();
    const logger = mockedLogger();
    executeCommand(['guide'], store, logger);
    const logs = logger.getLogs();
    expect(logs.some(l => l.message.includes('User Guide'))).toBe(true);
  });
});

describe('Command Executor — Status', () => {
  test('should run global status', () => {
    store = createTestStore();
    const logger = mockedLogger();
    store.createSpace('test', 'Test', ['test']);
    store.addMemory('test', 'mem', 'content', { tags: ['test'] });

    executeCommand(['status'], store, logger);
    const logs = logger.getLogs();
    expect(logs.some(l => l.message.includes('Status'))).toBe(true);
    // Should show tier labels
    expect(logs.some(l => l.message.includes('T1') || l.message.includes('hot'))).toBe(true);
  });

  test('should render the provider-aware RAG status line', () => {
    store = createTestStore();
    const logger = mockedLogger();

    executeCommand(['status'], store, logger);

    const ragLine = `   ${style('RAG:', ['bold'])} disabled (set MIND_RAG=true)`;
    const messages = logger.getLogs().map(entry => entry.message);

    expect(messages).toContain(ragLine);
    expect(messages.join('\n')).not.toContain('+ OPENAI_API_KEY');
  });

  test('should run space-scoped status', () => {
    store = createTestStore();
    const logger = mockedLogger();
    store.createSpace('test', 'Test', ['test']);
    store.addMemory('test', 'mem', 'content', { tags: ['test'] });

    executeCommand(['status', 'test'], store, logger);
    const logs = logger.getLogs();
    expect(logs.some(l => l.message.includes('test'))).toBe(true);
  });

  test('should reject --tier 4 when adding a memory (T4 has been removed)', () => {
    store = createTestStore();
    const logger = mockedLogger();
    store.createSpace('test', 'Test', ['test']);

    expect(() =>
      executeCommand(['add', 'test', 'frozen', 'content', '--tier', '4'], store, logger)
    ).toThrow('must be 1, 2, or 3');
  });
});

describe('Command Executor — Checkpoint', () => {
  test('should create a checkpoint', async () => {
    store = createTestStore();
    const logger = mockedLogger();
    store.createSpace('myproject', 'A project', ['test']);

    await executeCommand(
      ['checkpoint', 'set', 'myproject', 'Implement auth', 'Fix login bug'],
      store,
      logger
    );

    // Check memory was created in the same space (not a hidden :sessions space)
    const memories = store.listMemories('myproject', { tag: 'checkpoint' });
    expect(memories.length).toBe(1);
    expect(memories[0]!.tags).toContain('checkpoint');
    expect(memories[0]!.tags).toContain('active');
    expect(memories[0]!.tier).toBe(1); // T1 hot

    // No :sessions space should exist
    expect(store.getSpace('myproject:sessions')).toBeNull();

    // Check log output
    const logs = logger.getLogs();
    expect(logs.some(l => l.message.includes('Checkpoint created'))).toBe(true);
  });

  test('should update existing active checkpoint', async () => {
    store = createTestStore();
    const logger = mockedLogger();
    store.createSpace('myproject', 'A project', ['test']);

    // Create first checkpoint
    await executeCommand(
      ['checkpoint', 'set', 'myproject', 'First goal', 'First pending'],
      store,
      logger
    );
    const memories1 = store.listMemories('myproject', { tag: 'checkpoint' });
    const firstId = memories1[0]!.id;

    // Update the same checkpoint
    await executeCommand(
      ['checkpoint', 'set', 'myproject', 'Updated goal', 'Updated pending'],
      store,
      logger
    );
    const memories2 = store.listMemories('myproject', { tag: 'checkpoint' });

    // Should still be one checkpoint (updated, not created)
    expect(memories2.length).toBe(1);
    expect(memories2[0]!.id).toBe(firstId);

    // Check content was updated
    const mem = store.getMemoryById(firstId);
    const content = JSON.parse(mem!.content);
    expect(content.goal).toBe('Updated goal');

    const logs = logger.getLogs();
    expect(logs.some(l => l.message.includes('updated'))).toBe(true);
  });

  test('should recover checkpoint by name', async () => {
    store = createTestStore();
    const logger = mockedLogger();
    store.createSpace('myproject', 'A project', ['test']);

    // Create checkpoint
    await executeCommand(
      ['checkpoint', 'set', 'myproject', 'My goal', 'My pending'],
      store,
      logger
    );

    // Get checkpoint name
    const memories = store.listMemories('myproject', { tag: 'checkpoint' });
    const cpName = memories[0]!.name;

    // Recover it by name
    await executeCommand(['checkpoint', 'recover', 'myproject', '--name', cpName], store, logger);

    const logs = logger.getLogs();
    // Should output JSON with checkpoint info
    const payload = logs.map(l => l.message).find(m => m.includes('"name"'));
    expect(payload).toBeDefined();
    expect(payload).toContain('My goal');
    expect(payload).toContain('My pending');
    // Should NOT contain context_hits
    expect(payload).not.toContain('context_hits');
  });

  test('should show helpful error when checkpoint name is omitted', async () => {
    store = createTestStore();
    const logger = mockedLogger();
    store.createSpace('myproject', 'A project', ['test']);

    await executeCommand(['checkpoint', 'recover', 'myproject'], store, logger);

    const logs = logger.getLogs();
    expect(logs.some(l => l.message.includes('Checkpoint name is required'))).toBe(true);
    expect(logs.some(l => l.message.includes('checkpoint list'))).toBe(true);
  });

  test('should complete a checkpoint', async () => {
    store = createTestStore();
    const logger = mockedLogger();
    store.createSpace('myproject', 'A project', ['test']);

    // Create a completed checkpoint (pending cleared)
    await executeCommand(['checkpoint', 'set', 'myproject', 'Goal', ''], store, logger);
    const memories = store.listMemories('myproject', { tag: 'checkpoint' });
    const cpName = memories[0]!.name;

    // Complete it - transforms to session memory and deletes checkpoint
    await executeCommand(
      ['checkpoint', 'complete', 'myproject', cpName, 'Fixed the bug'],
      store,
      logger
    );

    // Check the original checkpoint is deleted
    const updated = store.getMemory('myproject', cpName);
    expect(updated).toBeNull();

    // Check session memory was created in myproject
    expect(store.getSpace('sessions/myproject')).toBeNull();
    const sessionsMemories = store.queryMemories({ space: 'myproject', tag: 'type:session' });
    expect(sessionsMemories.length).toBeGreaterThan(0);
    const sessionMem = sessionsMemories.find(m => m.tags.includes('type:session'));
    expect(sessionMem).toBeDefined();
    expect(sessionMem!.tags).toContain('cat:summary');
    expect(sessionMem!.tier).toBe(3);

    const logs = logger.getLogs();
    expect(logs.some(l => l.message.includes('transformed into session memory'))).toBe(true);
  });

  test('should refuse to complete a checkpoint with pending work', async () => {
    store = createTestStore();
    const logger = mockedLogger();
    store.createSpace('myproject', 'A project', ['test']);

    await executeCommand(
      ['checkpoint', 'set', 'myproject', 'Goal', 'Still pending'],
      store,
      logger
    );
    const memories = store.listMemories('myproject', { tag: 'checkpoint' });
    const cpName = memories[0]!.name;

    await executeCommand(
      ['checkpoint', 'complete', 'myproject', cpName, 'Tried early'],
      store,
      logger
    );

    expect(store.getMemory('myproject', cpName)).not.toBeNull();
    expect(store.queryMemories({ space: 'myproject', tag: 'type:session' })).toHaveLength(0);
    const logs = logger.getLogs();
    expect(logs.some(l => l.message.includes('pending work'))).toBe(true);
  });

  test('checkpoint set preserves existing notes when --notes is omitted', async () => {
    store = createTestStore();
    const logger = mockedLogger();
    store.createSpace('myproject', 'A project', ['test']);

    await executeCommand(
      [
        'checkpoint',
        'set',
        'myproject',
        'First goal',
        'First pending',
        '--notes',
        'Original notes',
      ],
      store,
      logger
    );

    await executeCommand(
      ['checkpoint', 'set', 'myproject', 'Updated goal', 'Updated pending'],
      store,
      logger
    );

    const memories = store.listMemories('myproject', { tag: 'checkpoint' });
    expect(memories).toHaveLength(1);
    const mem = store.getMemoryById(memories[0]!.id);
    const content = JSON.parse(mem!.content);
    expect(content.goal).toBe('Updated goal');
    expect(content.pending).toBe('Updated pending');
    expect(content.notes).toBe('Original notes');
  });

  test('should list checkpoints', async () => {
    store = createTestStore();
    const logger = mockedLogger();
    store.createSpace('myproject', 'A project', ['test']);

    // Create checkpoint
    await executeCommand(['checkpoint', 'set', 'myproject', 'Goal', 'Pending'], store, logger);

    // List active checkpoints
    await executeCommand(['checkpoint', 'list', 'myproject'], store, logger);

    const logs = logger.getLogs();
    expect(logs.some(l => l.message.includes('Checkpoints for'))).toBe(true);
    // Should show 1 active checkpoint
    expect(logs.some(l => l.message.includes('checkpoint-'))).toBe(true);
  });

  test('checkpoint_save does not create separate session space', async () => {
    store = createTestStore();
    const logger = mockedLogger();
    store.createSpace('myproject', 'A project', ['test']);

    await executeCommand(['checkpoint', 'set', 'myproject', 'Goal', 'Pending'], store, logger);

    // No :sessions space should exist
    expect(store.getSpace('myproject:sessions')).toBeNull();

    // Checkpoint should be in the project space
    const memories = store.listMemories('myproject', { tag: 'checkpoint' });
    expect(memories.length).toBe(1);
  });

  test('should create checkpoint with notes', async () => {
    store = createTestStore();
    const logger = mockedLogger();
    store.createSpace('myproject', 'A project', ['test']);

    await executeCommand(
      ['checkpoint', 'set', 'myproject', 'Goal', 'Pending', '--notes', 'Important context'],
      store,
      logger
    );

    const memories = store.listMemories('myproject', { tag: 'checkpoint' });
    const mem = store.getMemoryById(memories[0]!.id);
    const content = JSON.parse(mem!.content);

    expect(content.notes).toBe('Important context');
  });

  test('should dry-run migrate legacy session summaries into the project space', async () => {
    store = createTestStore();
    const logger = mockedLogger();
    store.createSpace('projects/mind', 'Mind project', ['type:project']);
    store.createSpace('sessions/mind', 'Legacy sessions', ['type:project']);
    await store.addMemory('sessions/mind', 'summary-session-1', 'Legacy summary', {
      tags: ['type:session', 'cat:discovery'],
    });

    await executeCommand(['migrate', 'sessions', 'projects/mind', '--dry-run'], store, logger);

    const report = logger
      .getLogs()
      .map(entry => entry.message)
      .find(message => message.includes('"dryRun": true'));

    expect(report).toBeDefined();
    expect(report).toContain('summary-session-1');
    expect(report).toContain('projects/mind');
    expect(store.getMemory('sessions/mind', 'summary-session-1')).not.toBeNull();
  });
});

describe('Command Executor — Tags', () => {
  test('should list all tags', () => {
    store = createTestStore();
    const logger = mockedLogger();
    store.createSpace('test', 'Test', ['test']);
    store.addSpaceTag('test', 'project');
    store.addSpaceTag('test', 'important');

    executeCommand(['tags'], store, logger);

    const logs = logger.getLogs();
    expect(logs.some(l => l.message.includes('project'))).toBe(true);
    expect(logs.some(l => l.message.includes('important'))).toBe(true);
  });

  test('should list only space tags', () => {
    store = createTestStore();
    const logger = mockedLogger();
    store.createSpace('test', 'Test', ['test']);
    store.addSpaceTag('test', 'project');

    executeCommand(['tags', '--spaces'], store, logger);

    const logs = logger.getLogs();
    expect(logs.some(l => l.message.includes('project'))).toBe(true);
  });

  test('should list only memory tags', async () => {
    store = createTestStore();
    const logger = mockedLogger();
    store.createSpace('test', 'Test', ['test']);
    store.addSpaceTag('test', 'space-tag');
    const mem = await store.addMemory('test', 'mem', 'content', { tags: ['test'] });
    store.addMemoryTag(mem.id, 'memory-tag');

    executeCommand(['tags', '--memories'], store, logger);

    const logs = logger.getLogs();
    expect(logs.some(l => l.message.includes('memory-tag'))).toBe(true);
  });
});
