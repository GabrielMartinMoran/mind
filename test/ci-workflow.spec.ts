import { describe, expect, it } from 'bun:test';
import { parse as parseYaml } from 'yaml';

const repoRoot = new URL('..', import.meta.url).pathname;
const workflowPath = `${repoRoot}.github/workflows/main.yml`;

interface WorkflowStep {
  name?: string;
  run?: string;
  uses?: string;
  with?: Record<string, unknown>;
}

interface WorkflowJob {
  steps?: WorkflowStep[];
  if?: unknown;
  needs?: unknown;
}

interface Workflow {
  on?: Record<string, unknown>;
  jobs?: Record<string, WorkflowJob>;
}

const workflowText = await Bun.file(workflowPath).text();
const workflow = parseYaml(workflowText) as Workflow;
const jobs = workflow.jobs ?? {};

function job(name: string): WorkflowJob {
  const value = jobs[name];
  if (!value) {
    throw new Error(`Missing workflow job: ${name}`);
  }
  return value;
}

function runCommands(workflowJob: WorkflowJob): string[] {
  return (workflowJob.steps ?? [])
    .map(step => step.run)
    .filter((run): run is string => typeof run === 'string');
}

function setupBunStep(workflowJob: WorkflowJob): WorkflowStep {
  const step = (workflowJob.steps ?? []).find(candidate =>
    candidate.uses?.startsWith('oven-sh/setup-bun')
  );
  if (!step) {
    throw new Error('Missing setup-bun step');
  }
  return step;
}

type TriggerConfig = Record<string, unknown>;

const FILTER_KEYS = [
  'branches',
  'branches-ignore',
  'paths',
  'paths-ignore',
  'tags',
  'tags-ignore',
  'types',
] as const;

function trigger(event: string): TriggerConfig {
  const value = (workflow.on ?? {})[event];
  if (value === null || value === undefined) {
    return {};
  }
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`Unexpected trigger configuration for ${event}: ${String(value)}`);
  }
  return value as TriggerConfig;
}

function matchesBranchFilter(pattern: string, branch: string): boolean {
  const regex = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*|\*|\?/g, token => (token === '**' ? '.*' : token === '*' ? '[^/]*' : '[^/]'));

  return new RegExp(`^${regex}$`).test(branch);
}

function coversBranch(event: string, branch: string): boolean {
  const config = trigger(event);
  const included = config.branches;
  const ignored = config['branches-ignore'];

  if (
    Array.isArray(included) &&
    !included.some(pattern => matchesBranchFilter(String(pattern), branch))
  ) {
    return false;
  }
  if (
    Array.isArray(ignored) &&
    ignored.some(pattern => matchesBranchFilter(String(pattern), branch))
  ) {
    return false;
  }
  return true;
}

describe('CI trigger contract', () => {
  it('triggers exactly on push, pull_request, and workflow_dispatch', () => {
    expect(Object.keys(workflow.on ?? {}).sort()).toEqual([
      'pull_request',
      'push',
      'workflow_dispatch',
    ]);
  });

  it('keeps push and pull_request free of branch, path, tag, and type filters', () => {
    for (const event of ['push', 'pull_request']) {
      const config = trigger(event);

      expect(config).toEqual({});
      for (const key of FILTER_KEYS) {
        expect(config).not.toHaveProperty(key);
      }
    }
  });

  it('covers slash-named branches and any pull request base', () => {
    const branches = [
      'main',
      'develop',
      'feat/example',
      'fix/example',
      'refactor/subsystem/change',
    ];

    for (const branch of branches) {
      expect(coversBranch('push', branch)).toBe(true);
      expect(coversBranch('pull_request', branch)).toBe(true);
    }
  });

  it('runs jobs independently without branch gating', () => {
    for (const name of ['validate', 'benchmark-agent-memory']) {
      expect(job(name).if).toBeUndefined();
      expect(job(name).needs).toBeUndefined();
    }
  });
});

describe('CI workflow contract', () => {
  it('uses the deterministic format check without write commands', () => {
    const commands = runCommands(job('validate'));

    expect(commands).toContain('bun run format:check');
    expect(workflowText).not.toContain('format --check');
    expect(workflowText).not.toContain('prettier --write');
  });

  it('audits the root dependency graph without suppressing failures', () => {
    const commands = runCommands(job('validate'));

    expect(commands).toContain('bun audit --audit-level=high');
    expect(workflowText).not.toContain('npm audit');
    expect(workflowText).not.toContain('|| true');
    expect(workflowText).not.toContain('continue-on-error');
    expect(workflowText).not.toContain('pre-existing vulnerabilities');
  });

  it('audits the benchmark dependency graph independently without suppressing failures', () => {
    const commands = runCommands(job('benchmark-agent-memory'));

    expect(commands).toContain('bun audit --audit-level=high');
    expect(workflowText).not.toContain('|| true');
    expect(workflowText).not.toContain('continue-on-error');
  });

  it('runs each audit after its frozen install', () => {
    for (const name of ['validate', 'benchmark-agent-memory']) {
      const steps = (job(name).steps ?? []).filter(step => typeof step.run === 'string');
      const installIndex = steps.findIndex(step =>
        step.run?.includes('bun install --frozen-lockfile')
      );
      const auditIndex = steps.findIndex(step =>
        step.run?.includes('bun audit --audit-level=high')
      );

      expect(installIndex).toBeGreaterThanOrEqual(0);
      expect(auditIndex).toBeGreaterThan(installIndex);
    }
  });

  it('uses the project typecheck script instead of a raw compiler call', () => {
    const commands = runCommands(job('validate'));

    expect(commands).toContain('bun run typecheck');
    expect(commands).not.toContain('bun tsc --noEmit');
  });

  it('pins Bun in every job', () => {
    for (const name of ['validate', 'benchmark-agent-memory']) {
      expect(setupBunStep(job(name)).with?.['bun-version']).toBe('1.3.14');
    }
  });

  it('installs the root and benchmark lockfiles independently', () => {
    const rootCommands = runCommands(job('validate'));
    const benchmarkCommands = runCommands(job('benchmark-agent-memory'));

    expect(rootCommands).toContain('bun install --frozen-lockfile');
    expect(benchmarkCommands).toContain('bun install --frozen-lockfile');
    expect(jobs['benchmark-agent-memory']).toBeDefined();
    expect(job('benchmark-agent-memory')).not.toBe(jobs['validate']);
  });

  it('runs the benchmark typecheck, tests, and experiments without paid stages', () => {
    const commands = runCommands(job('benchmark-agent-memory'));

    expect(commands).toContain('bun run typecheck');
    expect(commands).toContain('bun test test');
    expect(commands).toContain('bun test experiments');
    expect(workflowText).not.toMatch(/--budget|--confirm|locomo|--scenarios|--full/i);
  });

  it('keeps benchmark-only dependencies isolated from the root manifest', async () => {
    const rootManifest = (await Bun.file(`${repoRoot}package.json`).json()) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    const benchmarkManifest = (await Bun.file(
      `${repoRoot}benchmarks/agent-memory/package.json`
    ).json()) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    const benchmarkLock = await Bun.file(`${repoRoot}benchmarks/agent-memory/bun.lock`).text();
    const rootDependencies = { ...rootManifest.dependencies, ...rootManifest.devDependencies };
    const benchmarkDependencies = {
      ...benchmarkManifest.dependencies,
      ...benchmarkManifest.devDependencies,
    };

    expect(rootDependencies).not.toHaveProperty('@opencode/sdk');
    expect(benchmarkDependencies).toHaveProperty('@opencode/sdk');
    expect(benchmarkLock).toContain('@opencode/sdk');
  });

  it('keeps a single root lockfile and no npm lockfile', async () => {
    expect(await Bun.file(`${repoRoot}package-lock.json`).exists()).toBe(false);
    expect(await Bun.file(`${repoRoot}bun.lock`).exists()).toBe(true);
  });
});
