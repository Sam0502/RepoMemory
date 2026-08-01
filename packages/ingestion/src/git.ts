import simpleGit, { SimpleGit } from 'simple-git';
import { FileChange, Commit } from '@repo-memory/shared';

export class GitOperations {
  private git: SimpleGit;

  constructor(private repoPath: string) {
    this.git = simpleGit(repoPath);
  }

  async isRepository(): Promise<boolean> {
    try {
      await this.git.status();
      return true;
    } catch {
      return false;
    }
  }

  async getLatestCommit(): Promise<Commit | null> {
    try {
      const log = await this.git.log({ maxCount: 1 });
      if (log.latest) {
        return {
          hash: log.latest.hash,
          message: log.latest.message,
          author: log.latest.author_name,
          date: new Date(log.latest.date),
          filesChanged: [],
        };
      }
      return null;
    } catch {
      return null;
    }
  }

  async getCommitsSince(since: string): Promise<Commit[]> {
    try {
      const log = await this.git.log({ from: since });
      return log.all.map(entry => ({
        hash: entry.hash,
        message: entry.message,
        author: entry.author_name,
        date: new Date(entry.date),
        filesChanged: [],
      }));
    } catch {
      return [];
    }
  }

  // Returns the last `limit` commits, each with its own changed files and
  // per-file add/delete counts (from `git log --numstat`).
  async getRecentCommitsWithChanges(limit: number = 100): Promise<Array<Commit & { fileChanges: FileChange[] }>> {
    try {
      const format = '%x00%H%x00%an%x00%aI%x00%s';
      const output = await this.git.raw(['log', `--max-count=${limit}`, '--numstat', '--summary', `--pretty=format:${format}`]);
      const parts = output.split('\0');
      const commits: Array<Commit & { fileChanges: FileChange[] }> = [];
      for (let i = 1; i + 3 < parts.length; i += 4) {
        const hash = parts[i];
        const author = parts[i + 1];
        const date = new Date(parts[i + 2]);
        const tail = parts[i + 3];
        const firstLineEnd = tail.indexOf('\n');
        const subject = firstLineEnd === -1 ? tail : tail.slice(0, firstLineEnd);
        const numstatBlock = firstLineEnd === -1 ? '' : tail.slice(firstLineEnd + 1);
        const fileChanges = this.parseNumstatOutput(numstatBlock);
        commits.push({
          hash,
          message: subject,
          author,
          date,
          filesChanged: fileChanges.map(fc => fc.filePath),
          fileChanges,
        });
      }
      return commits;
    } catch {
      return [];
    }
  }

  async getDiffBetweenCommits(from: string, to: string): Promise<FileChange[]> {
    try {
      const diff = await this.git.diff([from, to, '--numstat', '--summary']);
      return this.parseNumstatOutput(diff);
    } catch {
      return [];
    }
  }

  async getWorkingTreeDiff(): Promise<FileChange[]> {
    try {
      const diff = await this.git.diff(['--numstat', '--summary']);
      return this.parseNumstatOutput(diff);
    } catch {
      return [];
    }
  }

  async getStagedDiff(): Promise<FileChange[]> {
    try {
      const diff = await this.git.diff(['--cached', '--numstat', '--summary']);
      return this.parseNumstatOutput(diff);
    } catch {
      return [];
    }
  }

  async getFileContent(filePath: string): Promise<string | null> {
    try {
      return await this.git.show([`HEAD:${filePath}`]);
    } catch {
      return null;
    }
  }

  async getWorkingTreeFileContent(filePath: string): Promise<string | null> {
    try {
      const fs = await import('fs/promises');
      const path = await import('path');
      const fullPath = path.join(this.repoPath, filePath);
      return await fs.readFile(fullPath, 'utf-8');
    } catch {
      return null;
    }
  }

  async getStatus(): Promise<{ modified: string[]; added: string[]; deleted: string[] }> {
    try {
      const status = await this.git.status();
      return {
        modified: status.modified,
        added: status.not_added,
        deleted: status.deleted,
      };
    } catch {
      return { modified: [], added: [], deleted: [] };
    }
  }

  async getLastCommitHash(): Promise<string | null> {
    try {
      const log = await this.git.log({ maxCount: 1 });
      return log.latest?.hash || null;
    } catch {
      return null;
    }
  }

  // Parses combined `--numstat --summary` output. Numstat lines carry add/
  // delete counts (`-` means binary); summary lines carry add/delete/rename
  // status letters git's plain numstat can't express.
  private parseNumstatOutput(output: string): FileChange[] {
    const changes: FileChange[] = [];
    const lines = output.split('\n');
    const summary = new Map<string, { status: FileChange['status']; oldPath?: string }>();

    // First pass: summary lines (create/delete/rename)
    for (const line of lines) {
      const trimmed = line.trim();
      const createMatch = trimmed.match(/^create mode \d+ (.+)$/);
      if (createMatch) {
        summary.set(createMatch[1], { status: 'added' });
        continue;
      }
      const deleteMatch = trimmed.match(/^delete mode \d+ (.+)$/);
      if (deleteMatch) {
        summary.set(deleteMatch[1], { status: 'deleted' });
        continue;
      }
      const renameMatch = trimmed.match(/^rename (.+) => (.+) \(\d+%\)$/);
      if (renameMatch) {
        summary.set(renameMatch[2], { status: 'renamed', oldPath: renameMatch[1] });
        continue;
      }
    }

    // Second pass: numstat lines
    for (const line of lines) {
      if (!line.includes('\t')) continue;

      const parts = line.split('\t');
      if (parts.length < 3) continue;

      const [adds, dels, pathPart] = parts;
      let filePath = pathPart;
      let oldPath: string | undefined;
      let status: FileChange['status'] = 'modified';

      if (filePath.includes(' => ')) {
        const [old, rest] = filePath.split(' => ');
        oldPath = old;
        filePath = rest;
        status = 'renamed';
      }

      const summaryEntry = summary.get(filePath);
      if (summaryEntry) {
        status = summaryEntry.status;
        oldPath = oldPath || summaryEntry.oldPath;
      }

      changes.push({
        filePath,
        additions: adds === '-' ? 0 : parseInt(adds, 10) || 0,
        deletions: dels === '-' ? 0 : parseInt(dels, 10) || 0,
        status,
        oldPath,
      });
    }

    return changes;
  }
}
