import chokidar, { FSWatcher } from 'chokidar';
import { EventEmitter } from 'events';
import { FileChange } from '@repo-memory/shared';

export interface FileWatcherEvents {
  'file:change': (change: FileChange) => void;
  'file:add': (change: FileChange) => void;
  'file:delete': (change: FileChange) => void;
  'ready': () => void;
  'error': (error: Error) => void;
}

export class FileWatcher extends EventEmitter {
  private watcher: FSWatcher | null = null;
  private watchedPaths: Set<string> = new Set();

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
    if (this.watcher) {
      return;
    }

    const defaultIgnored = [
      '**/node_modules/**',
      '**/.git/**',
      '**/dist/**',
      '**/build/**',
      '**/.next/**',
      '**/coverage/**',
    ];

    this.watcher = chokidar.watch(this.repoPath, {
      ignored: [...defaultIgnored, ...(this.options.ignored || [])],
      persistent: true,
      ignoreInitial: this.options.ignoreInitial ?? true,
      awaitWriteFinish: {
        stabilityThreshold: 100,
        pollInterval: 50,
      },
    });

    this.watcher
      .on('change', (path) => this.handleChange(path))
      .on('add', (path) => this.handleAdd(path))
      .on('unlink', (path) => this.handleDelete(path))
      .on('ready', () => this.emit('ready'))
      .on('error', (error) => this.emit('error', error));
  }

  async stop(): Promise<void> {
    if (this.watcher) {
      await this.watcher.close();
      this.watcher = null;
    }
  }

  async getChangedFiles(): Promise<FileChange[]> {
    // This would typically compare with a stored snapshot
    // For now, return an empty array
    return [];
  }

  private handleChange(filePath: string): void {
    const change: FileChange = {
      filePath: this.getRelativePath(filePath),
      additions: 0,
      deletions: 0,
      status: 'modified',
    };
    this.emit('file:change', change);
  }

  private handleAdd(filePath: string): void {
    const change: FileChange = {
      filePath: this.getRelativePath(filePath),
      additions: 0,
      deletions: 0,
      status: 'added',
    };
    this.emit('file:add', change);
  }

  private handleDelete(filePath: string): void {
    const change: FileChange = {
      filePath: this.getRelativePath(filePath),
      additions: 0,
      deletions: 0,
      status: 'deleted',
    };
    this.emit('file:delete', change);
  }

  private getRelativePath(absolutePath: string): string {
    let relative = absolutePath;
    if (absolutePath.startsWith(this.repoPath)) {
      relative = absolutePath.slice(this.repoPath.length + 1);
    }
    // Normalize to forward slashes so watcher paths match the git-derived
    // relative paths stored in the database on all platforms.
    return relative.replace(/\\/g, '/');
  }
}
