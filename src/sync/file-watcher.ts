// ── FileWatcher: monitors filesystem for changes using Node fs.watch ──

import { existsSync } from 'fs';
import { watch } from 'fs';

import type { FileEvent, FileEventType } from './types';

/** Default patterns to ignore */
const DEFAULT_IGNORE_PATTERNS = [
  /\.git\//,
  /node_modules\//,
  /\.DS_Store$/,
  /\.mind-sync\//,
  /\.tmp$/,
  /~$/,
  /^\.#/,
];

export interface FileWatcherOptions {
  /** Regex patterns to ignore (in addition to defaults) */
  ignorePattern?: RegExp[];
  /** Debounce window in ms (default: 250) */
  debounceMs?: number;
}

/**
 * FileWatcher wraps Node's fs.watch to detect file change events in a directory tree,
 * debounces rapid events for the same file, and ignores transient/temporary files.
 */
export class FileWatcher {
  private watcher: ReturnType<typeof watch> | null = null;
  private ignorePatterns: RegExp[];
  private debounceMs: number;
  private pendingEvents: Map<string, ReturnType<typeof setTimeout>> = new Map();

  constructor(
    private readonly basePath: string,
    private readonly handler: (event: FileEvent) => Promise<void>,
    options: FileWatcherOptions = {}
  ) {
    this.ignorePatterns = [...DEFAULT_IGNORE_PATTERNS, ...(options.ignorePattern ?? [])];
    this.debounceMs = options.debounceMs ?? 250;
  }

  /** Start watching the directory */
  start(): void {
    if (this.watcher) return;

    this.watcher = watch(
      this.basePath,
      { recursive: true },
      (eventType, filename: string | Buffer | null) => {
        if (!filename) return;
        const name: string = typeof filename === 'string' ? filename : filename.toString('utf-8');
        void this.handleFsEvent(eventType as string, name);
      }
    );

    this.watcher.on('error', (err: Error) => {
      console.error('[FileWatcher] error:', err?.message ?? err);
    });
  }

  /** Stop watching */
  stop(): void {
    if (this.watcher) {
      this.watcher.close();
      this.watcher = null;
    }
    // Clear any pending debounce timers
    for (const timer of this.pendingEvents.values()) {
      clearTimeout(timer);
    }
    this.pendingEvents.clear();
  }

  /**
   * Check if a path should be ignored.
   */
  isIgnored(filePath: string): boolean {
    const relative = filePath.replace(/^.*[\/\\]/, '');
    const fullPath = filePath;
    return this.ignorePatterns.some(pattern => pattern.test(relative) || pattern.test(fullPath));
  }

  /**
   * Map raw fs event type to FileEventType.
   * 'rename' on Unix can mean file was added or deleted.
   * We disambiguate by checking file existence.
   */
  private mapEventType(eventType: string, filePath: string): FileEventType {
    switch (eventType) {
      case 'rename': {
        // rename means add (file created) or unlink (file removed)
        // We check existence to disambiguate
        return existsSync(filePath) ? 'add' : 'unlink';
      }
      case 'change':
        return 'change';
      default:
        return 'change';
    }
  }

  /**
   * Primary event handler — debounces before calling the user handler.
   */
  private async handleFsEvent(rawEventType: string, filePath: string): Promise<void> {
    // Ignore non-markdown files immediately
    if (!filePath.endsWith('.md')) return;
    if (this.isIgnored(filePath)) return;

    const fullPath = filePath.startsWith('/')
      ? filePath
      : this.basePath.replace(/[\/\\]$/, '') + '/' + filePath;

    // Debounce: cancel any pending event for this file
    const existing = this.pendingEvents.get(fullPath);
    if (existing) {
      clearTimeout(existing);
    }

    // Schedule a new debounced handler
    const timer = setTimeout(async () => {
      this.pendingEvents.delete(fullPath);

      const eventType = this.mapEventType(rawEventType, fullPath);

      const event: FileEvent = {
        type: eventType,
        path: fullPath,
        timestamp: Date.now(),
      };

      try {
        await this.handler(event);
      } catch (err) {
        console.error(`[FileWatcher] handler error for ${fullPath}:`, err);
      }
    }, this.debounceMs);

    this.pendingEvents.set(fullPath, timer);
  }
}
