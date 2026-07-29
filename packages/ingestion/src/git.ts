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

  async getDiffBetweenCommits(from: string, to: string): Promise<FileChange[]> {
    try {
      const diff = await this.git.diff([from, to, '--name-status']);
      return this.parseDiffOutput(diff);
    } catch {
      return [];
    }
  }

  async getWorkingTreeDiff(): Promise<FileChange[]> {
    try {
      const diff = await this.git.diff(['--name-status']);
      return this.parseDiffOutput(diff);
    } catch {
      return [];
    }
  }

  async getStagedDiff(): Promise<FileChange[]> {
    try {
      const diff = await this.git.diff(['--cached', '--name-status']);
      return this.parseDiffOutput(diff);
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

  private parseDiffOutput(diff: string): FileChange[] {
    const changes: FileChange[] = [];
    const lines = diff.split('\n').filter(line => line.trim());

    for (const line of lines) {
      const parts = line.split('\t');
      if (parts.length < 2) continue;

      const status = parts[0];
      const filePath = parts[parts.length - 1];

      let changeStatus: FileChange['status'];
      switch (status) {
        case 'A':
          changeStatus = 'added';
          break;
        case 'M':
          changeStatus = 'modified';
          break;
        case 'D':
          changeStatus = 'deleted';
          break;
        case 'R':
          changeStatus = 'renamed';
          break;
        default:
          changeStatus = 'modified';
      }

      changes.push({
        filePath,
        additions: 0,
        deletions: 0,
        status: changeStatus,
        oldPath: status.startsWith('R') && parts.length > 2 ? parts[1] : undefined,
      });
    }

    return changes;
  }
}
