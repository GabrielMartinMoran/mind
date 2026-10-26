import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, test } from 'bun:test';

import { CONDITIONS } from '../src/config';
import {
  IsolationConfigError,
  applyMindDatabase,
  buildConfigContent,
  buildOpenCodeEnv,
  ensureIsolationDirs,
  isolationDirs,
  standaloneFlags,
} from '../src/isolation/opencode';
import { buildConditionProfiles, buildJudgeProfile } from '../src/opencode/conditions';

const conditionDir = '/runs/run-1/mind-v10';
const dir = isolationDirs(conditionDir);
const mindBin = '/worktrees/v10/mind';

interface ConfigShape {
  $schema: string;
  model: string;
  mcp?: {
    servers: Record<
      string,
      { type: string; command: string[]; environment: Record<string, string> }
    >;
  };
}

describe('isolationDirs', () => {
  test('keeps every path under the condition directory', () => {
    for (const value of Object.values(dir)) {
      expect(value.startsWith(conditionDir)).toBe(true);
    }
  });
});

describe('ensureIsolationDirs', () => {
  test('creates the isolated HOME/XDG/workspace tree on disk', () => {
    const root = mkdtempSync(join(tmpdir(), 'bench-iso-'));
    const d = isolationDirs(join(root, 'mind-v10'));
    // Regression: the isolated HOME must exist, or OpenCode's background
    // service fails `chdir` before any prompt (A2 was previously unwired).
    expect(existsSync(d.home)).toBe(false);
    ensureIsolationDirs(d);
    for (const path of [d.home, d.config, d.data, d.state, d.cache, d.workspace]) {
      expect(existsSync(path)).toBe(true);
    }
  });
});

describe('buildOpenCodeEnv', () => {
  test('sets isolated HOME/XDG dirs, a private DB and all disable guards', () => {
    const env = buildOpenCodeEnv({ condition: 'mind-v10', dir, mindBin });
    expect(env.HOME).toBe(dir.home);
    expect(env.XDG_CONFIG_HOME).toBe(dir.config);
    expect(env.XDG_DATA_HOME).toBe(dir.data);
    expect(env.XDG_STATE_HOME).toBe(dir.state);
    expect(env.XDG_CACHE_HOME).toBe(dir.cache);
    expect(env.OPENCODE_DB).toBe(dir.opencodeDb);
    expect(env.OPENCODE_DISABLE_PROJECT_CONFIG).toBe('1');
    expect(env.OPENCODE_DISABLE_CLAUDE_CODE).toBe('1');
    expect(env.OPENCODE_DISABLE_DEFAULT_PLUGINS).toBe('1');
    expect(env.OPENCODE_DISABLE_MODELS_FETCH).toBe('1');
    expect(env.OPENCODE_DISABLE_AUTOCOMPACT).toBe('1');
    expect(JSON.parse(env.OPENCODE_CONFIG_CONTENT!).model).toBe('openrouter/openai/gpt-6-luna');
  });

  test('points every Mind path at the unit directory and disables RAG by default', () => {
    const env = buildOpenCodeEnv({ condition: 'mind-current', dir, mindBin });
    expect(env.MIND_DB_PATH).toBe(dir.mindDb);
    expect(env.MIND_DATA_DIR).toBe(dir.mindDataDir);
    expect(env.MIND_SYNC_ROOT).toBe(dir.syncRoot);
    expect(env.MIND_RAG).toBe('false');
    for (const value of [env.MIND_DB_PATH, env.MIND_DATA_DIR, env.MIND_SYNC_ROOT]) {
      expect(value!.startsWith(conditionDir)).toBe(true);
    }
  });

  test('enables RAG and the selected embedding provider only when requested', () => {
    const off = buildOpenCodeEnv({ condition: 'mind-current', dir, mindBin });
    expect(off.MIND_RAG).toBe('false');
    expect(off.MIND_EMBEDDING_PROVIDER).toBeUndefined();

    const on = buildOpenCodeEnv({
      condition: 'mind-current',
      dir,
      mindBin,
      rag: true,
      embeddingProvider: 'openrouter',
    });
    expect(on.MIND_RAG).toBe('true');
    expect(on.MIND_EMBEDDING_PROVIDER).toBe('openrouter');
    const config = JSON.parse(on.OPENCODE_CONFIG_CONTENT!) as ConfigShape & {
      mcp?: { servers: Record<string, { environment: Record<string, string> }> };
    };
    const mindEnv = config.mcp!.servers.mind!.environment;
    expect(mindEnv.MIND_RAG).toBe('true');
    expect(mindEnv.MIND_EMBEDDING_PROVIDER).toBe('openrouter');
  });

  test('never embeds a credential in the OpenCode config content', () => {
    const env = buildOpenCodeEnv({
      condition: 'mind-current',
      dir,
      mindBin,
      rag: true,
      embeddingProvider: 'openrouter',
    });
    expect(env.OPENCODE_CONFIG_CONTENT).not.toMatch(/API_KEY|sk-or-/i);
  });
});

describe('buildConfigContent', () => {
  test('no-memory defines the pinned model and zero MCP servers', () => {
    const config = JSON.parse(
      buildConfigContent({ condition: 'no-memory', dir, mindBin: null })
    ) as ConfigShape;
    expect(config.model).toBe('openrouter/openai/gpt-6-luna');
    expect(config.mcp).toBeUndefined();
  });

  test.each(['mind-v9', 'mind-v10'] as const)(
    '%s defines exactly one local mind MCP server',
    condition => {
      const config = JSON.parse(buildConfigContent({ condition, dir, mindBin })) as ConfigShape;
      const servers = config.mcp?.servers;
      expect(servers).toBeDefined();
      expect(Object.keys(servers!)).toEqual(['mind']);
      const mind = servers!.mind!;
      expect(mind.type).toBe('local');
      expect(mind.command).toEqual([mindBin, 'mcp']);
      expect(mind.environment.MIND_DB_PATH).toBe(dir.mindDb);
      expect(mind.environment.MIND_DB_PATH!.startsWith(conditionDir)).toBe(true);
      expect(mind.environment.MIND_DATA_DIR).toBe(dir.mindDataDir);
      expect(mind.environment.MIND_SYNC_ROOT).toBe(dir.syncRoot);
      expect(mind.environment.MIND_RAG).toBe('false');
    }
  );

  test('every condition produces valid JSON with no secret material', () => {
    for (const condition of CONDITIONS) {
      const content = buildConfigContent({
        condition,
        dir,
        mindBin: condition === 'no-memory' ? null : mindBin,
      });
      expect(() => JSON.parse(content)).not.toThrow();
      expect(content).not.toMatch(/api[_-]?key|token|secret|password/i);
    }
  });

  test('merges scenario Mind env only into the Mind MCP server environment', () => {
    const env = buildOpenCodeEnv({
      condition: 'mind-current',
      dir,
      mindBin,
      mindEnv: {
        USE_DEBUGGING_EXPANDED_TOOLS_RESPONSE: 'true',
        // Reserved isolation pointers cannot be overridden by a scenario.
        MIND_DB_PATH: '/leak/mind.db',
      },
    });
    const config = JSON.parse(env.OPENCODE_CONFIG_CONTENT!) as ConfigShape;
    expect(config.mcp!.servers.mind!.environment.USE_DEBUGGING_EXPANDED_TOOLS_RESPONSE).toBe(
      'true'
    );
    expect(config.mcp!.servers.mind!.environment.MIND_DB_PATH).toBe(dir.mindDb);
    // The parent worker environment never receives the scenario-only flag.
    expect(env.USE_DEBUGGING_EXPANDED_TOOLS_RESPONSE).toBeUndefined();
  });

  test('leaves the scenario Mind env unset when a scenario declares none', () => {
    const config = JSON.parse(
      buildConfigContent({ condition: 'mind-current', dir, mindBin })
    ) as ConfigShape;
    expect(
      config.mcp!.servers.mind!.environment.USE_DEBUGGING_EXPANDED_TOOLS_RESPONSE
    ).toBeUndefined();
  });

  test('throws when a mind condition is missing its binary', () => {
    expect(() => buildConfigContent({ condition: 'mind-v9', dir, mindBin: null })).toThrow(
      IsolationConfigError
    );
  });

  test('throws when no-memory is given a binary', () => {
    expect(() => buildConfigContent({ condition: 'no-memory', dir, mindBin })).toThrow(
      IsolationConfigError
    );
  });
});

describe('applyMindDatabase', () => {
  test('rewires the Mind pointers but preserves the inline instructions', () => {
    const env = buildOpenCodeEnv({ condition: 'mind-current', dir, mindBin });
    const activation = '/isolated/home/.config/opencode/instructions/mind-memory-protocol.md';
    const withInstruction = {
      ...env,
      OPENCODE_CONFIG_CONTENT: `${JSON.stringify(
        { ...JSON.parse(env.OPENCODE_CONFIG_CONTENT!), instructions: [activation] },
        null,
        2
      )}\n`,
    };

    const next = applyMindDatabase(withInstruction, {
      dbPath: '/next/mind.db',
      dataDir: '/next',
      syncRoot: '/next/sync',
    });
    const config = JSON.parse(next.OPENCODE_CONFIG_CONTENT!) as {
      instructions?: string[];
      mcp?: { servers: Record<string, { environment: Record<string, string> }> };
    };

    expect(config.instructions).toEqual([activation]);
    expect(config.mcp!.servers.mind!.environment.MIND_DB_PATH).toBe('/next/mind.db');
    expect(config.mcp!.servers.mind!.environment.MIND_DATA_DIR).toBe('/next');
    expect(config.mcp!.servers.mind!.environment.MIND_SYNC_ROOT).toBe('/next/sync');
  });
});

describe('applyMindDatabase scenario Mind env', () => {
  test('preserves the scenario Mind MCP environment override', () => {
    const env = buildOpenCodeEnv({
      condition: 'mind-current',
      dir,
      mindBin,
      mindEnv: { USE_DEBUGGING_EXPANDED_TOOLS_RESPONSE: 'true' },
    });

    const next = applyMindDatabase(env, {
      dbPath: '/next/mind.db',
      dataDir: '/next',
      syncRoot: '/next/sync',
    });
    const config = JSON.parse(next.OPENCODE_CONFIG_CONTENT!) as ConfigShape;

    expect(config.mcp!.servers.mind!.environment.USE_DEBUGGING_EXPANDED_TOOLS_RESPONSE).toBe(
      'true'
    );
    expect(config.mcp!.servers.mind!.environment.MIND_DB_PATH).toBe('/next/mind.db');
  });
});

describe('standaloneFlags', () => {
  test('returns the private-server fallback flag', () => {
    expect(standaloneFlags()).toEqual(['--standalone']);
  });
});

describe('provider credential injection', () => {
  test('merges the credential env into every condition profile', () => {
    const profiles = buildConditionProfiles({
      runDir: '/runs/run-1',
      conditions: ['no-memory', 'mind-v10'],
      worktrees: { v10: '/worktrees/v10' },
      credentialEnv: { OPENROUTER_API_KEY: 'test-key' },
    });
    expect(profiles).toHaveLength(2);
    for (const profile of profiles) {
      expect(profile.env.OPENROUTER_API_KEY).toBe('test-key');
      expect(JSON.parse(profile.env.OPENCODE_CONFIG_CONTENT!).model).toBe(
        'openrouter/openai/gpt-6-luna'
      );
    }
  });

  test('injects the credential into the judge profile too', () => {
    const judge = buildJudgeProfile('/runs/run-1', { OPENROUTER_API_KEY: 'test-key' });
    expect(judge.env.OPENROUTER_API_KEY).toBe('test-key');
  });
});

describe('A2 condition profile RAG wiring', () => {
  test('keeps every profile RAG-off by default', () => {
    const profiles = buildConditionProfiles({
      runDir: '/runs/run-1',
      conditions: ['mind-current', 'no-memory'],
      worktrees: { current: '/worktrees/current' },
    });
    for (const profile of profiles) {
      expect(profile.env.MIND_RAG).toBe('false');
      expect(profile.env.MIND_EMBEDDING_PROVIDER).toBeUndefined();
    }
  });

  test('enables RAG and the OpenRouter provider in every profile for a RAG run', () => {
    const profiles = buildConditionProfiles({
      runDir: '/runs/run-1',
      conditions: ['mind-current'],
      worktrees: { current: '/worktrees/current' },
      rag: true,
    });
    expect(profiles).toHaveLength(1);
    const profile = profiles[0]!;
    expect(profile.env.MIND_RAG).toBe('true');
    expect(profile.env.MIND_EMBEDDING_PROVIDER).toBe('openrouter');
    const config = JSON.parse(profile.env.OPENCODE_CONFIG_CONTENT!) as {
      mcp?: { servers: Record<string, { environment: Record<string, string> }> };
    };
    expect(config.mcp!.servers.mind!.environment.MIND_RAG).toBe('true');
    expect(config.mcp!.servers.mind!.environment.MIND_EMBEDDING_PROVIDER).toBe('openrouter');
  });
});
