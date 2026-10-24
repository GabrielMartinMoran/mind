import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, test } from 'bun:test';

const repoRoot = join(import.meta.dir, '..');
const dockerfile = readFileSync(join(repoRoot, 'web/Dockerfile'), 'utf8');
const compose = readFileSync(join(repoRoot, 'docker-compose.yml'), 'utf8');

describe('web Docker image contract', () => {
  test('pins the Bun base image to the version CI uses', () => {
    expect(dockerfile).toMatch(/^FROM oven\/bun:1\.3\.14-alpine$/m);
    expect(dockerfile).not.toMatch(/^FROM oven\/bun:1-alpine$/m);
  });

  test('Dockerfile builds from the repository root with a frozen install', () => {
    expect(dockerfile).toMatch(/^WORKDIR \/app$/m);
    expect(dockerfile).toContain('COPY package.json bun.lock ./');
    expect(dockerfile).toContain('COPY src/ ./src/');
    expect(dockerfile).toContain('COPY web/ ./web/');
    expect(dockerfile).toContain('RUN bun install --frozen-lockfile');
    expect(dockerfile).not.toMatch(/^WORKDIR \/app\/web$/m);
  });

  test('starts a self-starting foreground server', () => {
    const cmdLine = dockerfile.match(/^CMD .+$/m)?.[0] ?? '';

    expect(cmdLine).toContain('serve start');
    expect(cmdLine).toContain('src/mind.ts');
    expect(cmdLine).toContain('${MIND_PORT:-30303}');
    // `src/api/server.ts` only exports functions; running it exits immediately.
    expect(cmdLine).not.toContain('src/api/server.ts');
    expect(dockerfile).not.toContain('CMD ["bun", "run", "src/api/server.ts"]');
  });

  test('Dockerfile exposes the port the server reads', () => {
    expect(dockerfile).toContain('EXPOSE 30303');
  });

  test('compose publishes port 3000 to the server port and sets MIND_PORT', () => {
    expect(compose).toContain("- '3000:30303'");
    expect(compose).toContain('MIND_PORT=30303');
    expect(compose).not.toContain('PORT=3000');
  });
});
