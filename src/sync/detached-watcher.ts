// ── Detached Sync Watcher: manages a detached file-watcher process ──
// Uses PID file pattern consistent with mind serve / mind mcp

import { spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

const SYNC_PID_DIR = 'data';
const SYNC_PID_FILENAME = 'mind-sync-watch.pid';

/**
 * Get the directory where PID files are stored.
 */
function getPidDir(): string {
  const dir = path.join(process.cwd(), SYNC_PID_DIR);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  return dir;
}

/**
 * Get the PID file path for sync watcher.
 */
function getPidPath(): string {
  return path.join(getPidDir(), SYNC_PID_FILENAME);
}

/**
 * Write PID to file.
 */
function writePid(pid: number): void {
  fs.writeFileSync(getPidPath(), String(pid));
}

/**
 * Read PID from file. Returns null if not running.
 */
function readPid(): number | null {
  const pidPath = getPidPath();
  if (!fs.existsSync(pidPath)) return null;
  const pid = Number(fs.readFileSync(pidPath, 'utf-8').trim());
  return Number.isFinite(pid) ? pid : null;
}

/**
 * Clear PID file.
 */
function clearPid(): void {
  const pidPath = getPidPath();
  if (fs.existsSync(pidPath)) {
    fs.unlinkSync(pidPath);
  }
}

/**
 * Check if a process is running.
 */
function isProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Get the mind entry script path.
 */
function getMindEntryPath(): string {
  // From src/sync/, go up 3 levels to repo root, then to mind script
  return path.resolve(__dirname, '..', '..', 'mind');
}

/**
 * Start a detached sync watcher for a specific space.
 * Spawns `mind sync serve --space <space>` in background.
 */
export async function startSyncWatcherDetached(space: string, projectRoot: string): Promise<void> {
  const existingPid = readPid();
  if (existingPid && isProcessRunning(existingPid)) {
    console.log(`Sync watcher already running for "${space}" (pid: ${existingPid})`);
    return;
  }

  const bunPath = process.execPath;
  const mindEntry = getMindEntryPath();

  // Pass project root via env var so the detached process finds the right .mind/
  const child = spawn(bunPath, ['run', mindEntry, 'sync', 'serve', '--space', space], {
    detached: true,
    stdio: 'ignore',
    cwd: projectRoot,
    env: { ...process.env, MIND_SYNC_ROOT: projectRoot },
  });
  child.unref();

  if (!child.pid) {
    console.log('Failed to start sync watcher');
    return;
  }

  // Wait a moment for process to start
  await new Promise(resolve => setTimeout(resolve, 500));

  if (!isProcessRunning(child.pid)) {
    console.log(
      'Failed to start sync watcher (process exited immediately). Check directory and path.'
    );
    return;
  }

  writePid(child.pid);
  console.log(`✅ Sync watcher started for "${space}" (pid: ${child.pid})`);
}

/**
 * Stop the detached sync watcher.
 */
export async function stopSyncWatcher(): Promise<void> {
  const pid = readPid();
  if (!pid) {
    console.log('Sync watcher not running');
    return;
  }

  if (!isProcessRunning(pid)) {
    clearPid();
    console.log('Sync watcher not running');
    return;
  }

  process.kill(pid, 'SIGTERM');
  clearPid();
  console.log(`✅ Sync watcher stopped (pid: ${pid})`);
}

/**
 * Get the status of the detached sync watcher.
 */
export function getSyncWatcherStatus(): { running: boolean; pid: number | null } {
  const pid = readPid();
  if (pid && isProcessRunning(pid)) {
    return { running: true, pid };
  }
  return { running: false, pid: null };
}
