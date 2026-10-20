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
}

interface Workflow {
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

describe('CI workflow contract', () => {
  it('uses the deterministic format check without write commands', () => {
    const commands = runCommands(job('validate'));

    expect(commands).toContain('bun run format:check');
    expect(workflowText).not.toContain('format --check');
    expect(workflowText).not.toContain('prettier --write');
  });

  it('does not gate a failing audit or hide audit failures', () => {
    const allCommands = Object.values(jobs).flatMap(workflowJob => runCommands(workflowJob));

    expect(allCommands.some(command => command.includes('audit'))).toBe(false);
    expect(workflowText).not.toContain('npm audit');
    expect(workflowText).not.toContain('|| true');
    expect(workflowText).not.toContain('continue-on-error');
    expect(workflowText).toContain('bun audit --audit-level=high');
    expect(workflowText).toContain('pre-existing vulnerabilities');
    expect(workflowText).toContain('2026-10-20');
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
