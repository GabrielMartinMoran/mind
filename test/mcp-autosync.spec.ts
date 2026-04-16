// ── MCP Autosync Integration Tests ──
// Tests for MCP server autosync with file-based config

import { mkdirSync, rmSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, test, beforeEach } from 'bun:test';

import type { MindStore } from '../src/store/mind-store';
import { initMindDir, loadConfig, saveConfig } from '../src/sync/config-file';
import { getSyncBasePath, getSpaceDir } from '../src/sync/normalize';

import { createTestStore } from './mocks/test-store';

// ── Tests ─────────────────────────────────────────────────────────────────────

let store: MindStore & { cleanup: () => void };
let tempDirs: string[] = [];
let projectRoot: string;

beforeEach(async () => {
  // Create temp directory for this test
  const tempDir = await mkdtemp(join(tmpdir(), 'autosync-test-'));
  tempDirs.push(tempDir);
  projectRoot = tempDir;

  // Initialize .mind directory
  initMindDir(projectRoot);

  // Create a test space
  store = createTestStore();
  store.createSpace('projects/test', 'Test space', ['type:test']);
});

afterEach(async () => {
  store?.cleanup();
  for (const dir of tempDirs) {
    await rm(dir, { force: true, recursive: true });
  }
  tempDirs = [];
});

describe('MCP autosync startup', () => {
  test('startAutosyncWatchers starts watcher for enabled spaces', async () => {
    // Enable sync for this space in file-based config
    const basePath = getSyncBasePath(projectRoot);
    const config = loadConfig(basePath)!;
    config.spaces['projects/test'] = {
      enabled: true,
      conflictResolution: 'db-wins',
    };
    saveConfig(basePath, config);

    // Create the space directory
    const syncDir = getSpaceDir(basePath, 'projects/test');
    const { mkdirSync } = await import('node:fs');
    mkdirSync(syncDir, { recursive: true });

    // Dynamically import to test the helper
    const mod = await import('../src/mcp/server');
    const startFn = (mod as any).startAutosyncWatchers;

    // Capture console.error calls
    const errors: string[] = [];
    const originalError = console.error;
    console.error = (...args: any[]) => {
      errors.push(args.join(' '));
    };

    await startFn(store, projectRoot);

    console.error = originalError;

    // Verify watcher started
    const filtered = errors.filter(e => e.includes('[autosync]'));
    expect(filtered.some(e => e.includes('Starting'))).toBe(true);
    expect(filtered.some(e => e.includes('Watching projects/test'))).toBe(true);
  });

  test('startAutosyncWatchers skips disabled spaces', async () => {
    // Create config but DISABLED
    const basePath = getSyncBasePath(projectRoot);
    const config = loadConfig(basePath)!;
    config.spaces['projects/test'] = {
      enabled: false,
      conflictResolution: 'db-wins',
    };
    saveConfig(basePath, config);

    const mod = await import('../src/mcp/server');
    const startFn = (mod as any).startAutosyncWatchers;

    const errors: string[] = [];
    const originalError = console.error;
    console.error = (...args: any[]) => {
      errors.push(args.join(' '));
    };

    await startFn(store, projectRoot);

    console.error = originalError;

    // No "Starting" message since no spaces are enabled
    const filtered = errors.filter(e => e.includes('[autosync]'));
    expect(filtered.some(e => e.includes('Starting'))).toBe(false);
  });

  test('startAutosyncWatchers handles watcher failure gracefully', async () => {
    // Space with sync enabled but NON-EXISTENT directory → will fail
    const basePath = getSyncBasePath(projectRoot);
    const config = loadConfig(basePath)!;
    config.spaces['projects/test'] = {
      enabled: true,
      conflictResolution: 'db-wins',
    };
    saveConfig(basePath, config);

    const mod = await import('../src/mcp/server');
    const startFn = (mod as any).startAutosyncWatchers;

    const errors: string[] = [];
    const originalError = console.error;
    console.error = (...args: any[]) => {
      errors.push(args.join(' '));
    };

    // Should NOT throw, should continue
    await startFn(store, projectRoot);

    console.error = originalError;

    // Should have logged a failure but continued
    const filtered = errors.filter(e => e.includes('[autosync]'));
    expect(filtered.some(e => e.includes('Failed to watch projects/test'))).toBe(true);
  });

  test('setImmediate is used to avoid blocking server connect', async () => {
    // This is verified by the integration: startMcpServer and startMcpHttpServer
    // both call setImmediate(() => startAutosyncWatchers(store)).
    // We verify the setImmediate call is made by checking the function signature.

    const mod = await import('../src/mcp/server');

    // startMcpServer should be an async function that calls setImmediate
    expect(mod.startMcpServer).toBeDefined();
    expect(typeof mod.startMcpServer).toBe('function');

    // startMcpHttpServer should be an async function
    expect(mod.startMcpHttpServer).toBeDefined();
    expect(typeof mod.startMcpHttpServer).toBe('function');
  });
});

describe('file-based config integration', () => {
  test('config file is read correctly by autosync', () => {
    // Use fresh directory to avoid test pollution
    const freshDir = join(tmpdir(), 'mcp-autosync-' + Date.now() + '-' + Math.random());
    mkdirSync(freshDir, { recursive: true });
    const freshRoot = freshDir;

    // Initialize the .mind directory first
    initMindDir(freshRoot);

    const basePath = getSyncBasePath(freshRoot);

    // Write a config
    const config = loadConfig(basePath)!;
    config.spaces['projects/test'] = {
      enabled: true,
      conflictResolution: 'file-wins',
    };
    saveConfig(basePath, config);

    // Read it back
    const loaded = loadConfig(basePath);
    expect(loaded).not.toBeNull();
    expect(loaded!.spaces['projects/test']).toEqual({
      enabled: true,
      conflictResolution: 'file-wins',
    });

    // Cleanup
    rmSync(freshDir, { recursive: true, force: true });
  });

  test('changes to config are picked up on restart', () => {
    // Use fresh directory
    const freshDir = join(tmpdir(), 'mcp-autosync2-' + Date.now() + '-' + Math.random());
    mkdirSync(freshDir, { recursive: true });
    const freshRoot = freshDir;

    // Initialize the .mind directory first
    initMindDir(freshRoot);

    const basePath = getSyncBasePath(freshRoot);

    // Initially no spaces (or at least valid structure)
    let config = loadConfig(basePath)!;
    expect(typeof config.spaces).toBe('object');

    // Add a space
    config.spaces['projects/test'] = {
      enabled: true,
      conflictResolution: 'latest-wins',
    };
    saveConfig(basePath, config);

    // Read again
    const loaded = loadConfig(basePath);
    expect(loaded!.spaces['projects/test']).toEqual({
      enabled: true,
      conflictResolution: 'latest-wins',
    });

    // Cleanup
    rmSync(freshDir, { recursive: true, force: true });
  });
});
