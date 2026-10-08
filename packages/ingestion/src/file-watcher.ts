import { EventEmitter } from 'events';
import { relative, sep } from 'path';
import { watch as fsWatch } from 'node:fs';
import { stat } from 'node:fs/promises';
import { FileChange } from '@repo-memory/shared';

export interface FileWatcherEvents {
  'file:change': (change: FileChange) => void;
  'file:add': (change: FileChange) => void;
  'file:delete': (change: FileChange) => void;
  'ready': () => void;
  'error': (error: Error) => void;
}

// Path segments always ignored by the watcher backends.
const DEFAULT_IGNORED_SEGMENTS = new Set([
  'node_modules',
  '.git',
  'dist',
  'build',
  '.next',
  'coverage',
]);

export class FileWatcher extends EventEmitter {
  private watcher: { close(): Promise<void> | void } | null = null;
  private starting: Promise<void> | null = null;
  private stopped = false;
  private pending = new Map<string, FileChange>();
  private debounceTimer: NodeJS.Timeout | null = null;

  constructor(
    private repoPath: string,
    private options: {
      ignoreInitial?: boolean;
      ignored?: string[];
      debounceMs?: number;
    } = {}
  ) {
    super();
  }

  start(): void {
    if (this.watcher || this.starting) {
      return;
    }
    this.stopped = false;
    this.starting = this.initBackend().catch((error: Error) => {
      this.emit('error', error);
    });
  }

  private async initBackend(): Promise<void> {
    if (this.stopped) return;
    try {
      await this.startChokidar();
    } catch {
      // chokidar is an optional dependency — fall back to node:fs.watch when
      // it isn't installed. Best-effort: no awaitWriteFinish stabilization
      // and segment-based ignores instead of globs.
      if (!this.stopped) this.startNative();
    }
  }

  private async startChokidar(): Promise<void> {
    const { default: chokidar } = await import('chokidar');
    if (this.stopped) return;
    const defaultIgnored = [
      '**/node_modules/**',
      '**/.git/**',
      '**/dist/**',
      '**/build/**',
      '**/.next/**',
      '**/coverage/**',
    ];

    const watcher = chokidar.watch(this.repoPath, {
      ignored: [...defaultIgnored, ...(this.options.ignored || [])],
      persistent: true,
      ignoreInitial: this.options.ignoreInitial ?? true,
      awaitWriteFinish: {
        stabilityThreshold: 100,
        pollInterval: 50,
      },
    });
    this.watcher = watcher;

    watcher
      .on('change', (path) => this.queueOrEmit('modified', path, 'file:change'))
      .on('add', (path) => this.queueOrEmit('added', path, 'file:add'))
      .on('unlink', (path) => this.queueOrEmit('deleted', path, 'file:delete'))
      .on('unlinkDir', (path) => this.queueOrEmit('deleted', path, 'file:delete'))
      .on('ready', () => this.emit('ready'))
      .on('error', (error) => this.emit('error', error));
  }

  private startNative(): void {
    const watcher = fsWatch(this.repoPath, { recursive: true });
    this.watcher = watcher;
    watcher.on('change', (eventType, filename) => {
      void this.onNativeEvent(eventType, filename);
    });
    watcher.on('error', (error) => this.emit('error', error));
    // node:fs.watch has no initial scan, so it is ready immediately.
    queueMicrotask(() => this.emit('ready'));
  }

  private async onNativeEvent(eventType: string, filename: string | Buffer | null): Promise<void> {
    try {
      if (filename === null || filename === undefined) return;
      const relPath = this.getRelativePath(String(filename));
      if (isIgnoredPath(relPath)) return;
      if (eventType === 'change') {
        this.queueOrEmit('modified', relPath, 'file:change');
        return;
      }
      // 'rename' covers adds and deletes: probe the path to tell them apart.
      // getRelativePath returns the absolute path (forward slashes) when the
      // name escapes the repo root; probe it as-is.
      const probePath = relPath.includes(':') || relPath.startsWith('/')
        ? relPath
        : `${this.repoPath}${sep}${relPath}`;
      try {
        await stat(probePath);
        this.queueOrEmit('added', relPath, 'file:add');
      } catch {
        this.queueOrEmit('deleted', relPath, 'file:delete');
      }
    } catch (error) {
      this.emit('error', error instanceof Error ? error : new Error(String(error)));
    }
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
    this.pending.clear();
    if (this.starting) {
      try {
        await this.starting;
      } finally {
        this.starting = null;
      }
    }
    if (this.watcher) {
      await this.watcher.close();
      this.watcher = null;
    }
  }

  /** Legacy snapshot API — the orchestrator consumes live events instead. */
  async getChangedFiles(): Promise<FileChange[]> {
    return [];
  }

  private queueOrEmit(status: FileChange['status'], absPath: string, event: 'file:change' | 'file:add' | 'file:delete'): void {
    const change: FileChange = {
      filePath: this.getRelativePath(absPath),
      additions: 0,
      deletions: 0,
      status,
    };
    const debounceMs = this.options.debounceMs ?? 0;
    if (!debounceMs || debounceMs <= 0) {
      this.emit(event, change);
      return;
    }
    // Coalesce rapid saves: last status per path wins within the window.
    this.pending.set(`${event}:${change.filePath}`, { ...change, __event: event } as FileChange & { __event: typeof event });
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null;
      const batch = [...this.pending.values()];
      this.pending.clear();
      for (const item of batch) {
        const { __event, ...rest } = item as FileChange & { __event: typeof event };
        this.emit(__event, rest as FileChange);
      }
    }, debounceMs);
    // Allow process exit when only the debounce timer remains.
    (this.debounceTimer as unknown as { unref?: () => void }).unref?.();
  }

  private getRelativePath(absolutePath: string): string {
    // node:fs.watch hands back paths relative to the watched root (or bare
    // names); chokidar hands back absolute paths. Handle both.
    const looksAbsolute = absolutePath.includes(':') || absolutePath.startsWith('/') || absolutePath.startsWith('\\');
    const abs = looksAbsolute ? absolutePath : `${this.repoPath}${sep}${absolutePath}`;
    // path.relative handles trailing slashes, case, and separators so watcher
    // events match the git-derived relative paths stored in the database.
    const rel = relative(this.repoPath, abs);
    if (rel === '' || rel.startsWith('..')) return absolutePath.replace(/\\/g, '/');
    // Normalize to forward slashes so watcher paths match the git-derived
    // relative paths stored in the database on all platforms.
    return rel.replace(/\\/g, '/');
  }
}

function isIgnoredPath(relPath: string): boolean {
  return relPath.split('/').some((segment) => DEFAULT_IGNORED_SEGMENTS.has(segment));
}
