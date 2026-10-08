import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { FileChange, Commit, getLogger } from '@repo-memory/shared';

const execFileAsync = promisify(execFile);

const logger = getLogger({ component: 'ingestion' });

// Commits newer than `since` (exclusive): `since..HEAD`.
const LOG_ENTRY_FORMAT = '%H%x00%an%x00%aI%x00%s';

interface LogEntry {
  hash: string;
  author: string;
  date: Date;
  subject: string;
}

export class GitOperations {
  constructor(private repoPath: string) {}

  private async git(args: string[]): Promise<string> {
    const { stdout } = await execFileAsync('git', args, {
      cwd: this.repoPath,
      maxBuffer: 256 * 1024 * 1024,
    });
    return stdout;
  }

  async isRepository(): Promise<boolean> {
    try {
      const output = await this.git(['rev-parse', '--is-inside-work-tree']);
      return output.trim() === 'true';
    } catch {
      return false;
    }
  }

  async getLatestCommit(): Promise<Commit | null> {
    try {
      const output = await this.git(['log', '-1', `--pretty=format:${LOG_ENTRY_FORMAT}`]);
      const entries = parseLogEntries(output);
      if (entries.length === 0) return null;
      const latest = entries[0];
      return {
        hash: latest.hash,
        message: latest.subject,
        author: latest.author,
        date: latest.date,
        filesChanged: [],
      };
    } catch (error) {
      logger.error({ err: error }, 'git: getLatestCommit failed');
      throw error;
    }
  }

  async getCommitsSince(since: string): Promise<Commit[]> {
    try {
      const output = await this.git(['log', `${since}..HEAD`, `--pretty=format:${LOG_ENTRY_FORMAT}`]);
      return parseLogEntries(output).map((entry) => ({
        hash: entry.hash,
        message: entry.subject,
        author: entry.author,
        date: entry.date,
        filesChanged: [],
      }));
    } catch (error) {
      logger.error({ err: error }, 'git: getCommitsSince failed');
      throw error;
    }
  }

  // Returns the last `limit` commits, each with its own changed files and
  // per-file add/delete counts (from `git log --numstat`).
  async getRecentCommitsWithChanges(limit: number = 100): Promise<Array<Commit & { fileChanges: FileChange[] }>> {
    try {
      const format = '%x00%H%x00%an%x00%aI%x00%s';
      const output = await this.git(['log', `--max-count=${limit}`, '--numstat', '--summary', `--pretty=format:${format}`]);
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
    } catch (error) {
      logger.error({ err: error }, 'git: getRecentCommitsWithChanges failed');
      throw error;
    }
  }

  async getDiffBetweenCommits(from: string, to: string): Promise<FileChange[]> {
    try {
      const diff = await this.git(['diff', from, to, '--numstat', '--summary']);
      return this.parseNumstatOutput(diff);
    } catch (error) {
      logger.error({ err: error }, 'git: getDiffBetweenCommits failed');
      throw error;
    }
  }

  async getWorkingTreeDiff(): Promise<FileChange[]> {
    try {
      const diff = await this.git(['diff', '--numstat', '--summary']);
      return this.parseNumstatOutput(diff);
    } catch (error) {
      logger.error({ err: error }, 'git: getWorkingTreeDiff failed');
      throw error;
    }
  }

  async getStagedDiff(): Promise<FileChange[]> {
    try {
      const diff = await this.git(['diff', '--cached', '--numstat', '--summary']);
      return this.parseNumstatOutput(diff);
    } catch (error) {
      logger.error({ err: error }, 'git: getStagedDiff failed');
      throw error;
    }
  }

  async getFileContent(filePath: string): Promise<string | null> {
    try {
      return await this.git(['show', `HEAD:${filePath}`]);
    } catch {
      return null;
    }
  }

  async getWorkingTreeFileContent(filePath: string): Promise<string | null> {
    try {
      const fs = await import('fs/promises');
      const path = await import('path');
      const repoRoot = path.resolve(this.repoPath);
      const fullPath = path.resolve(repoRoot, filePath);
      const rel = path.relative(repoRoot, fullPath);
      if (rel.startsWith('..') || path.isAbsolute(rel)) {
        return null;
      }
      return await fs.readFile(fullPath, 'utf-8');
    } catch {
      return null;
    }
  }

  // Porcelain v1 status folded into the legacy shape: worktree/staged
  // modifications, untracked files, and deletions. Staged-new (`A`) and
  // renamed (`R`) entries are skipped, matching the previous mapping.
  async getStatus(): Promise<{ modified: string[]; added: string[]; deleted: string[] }> {
    try {
      const output = await this.git(['status', '--porcelain=v1', '-uall']);
      const modified: string[] = [];
      const added: string[] = [];
      const deleted: string[] = [];
      for (const line of output.split('\n')) {
        if (line.length < 4) continue;
        const x = line[0];
        const y = line[1];
        const filePath = unquotePorcelainPath(line.slice(3));
        if (x === '?' && y === '?') {
          added.push(filePath);
        } else if (x === 'D' || y === 'D') {
          deleted.push(filePath);
        } else if (x === 'M' || y === 'M') {
          modified.push(filePath);
        }
      }
      return { modified, added, deleted };
    } catch (error) {
      logger.error({ err: error }, 'git: getStatus failed');
      throw error;
    }
  }

  async getLastCommitHash(): Promise<string | null> {
    try {
      const output = await this.git(['log', '-1', '--pretty=format:%H']);
      const hash = output.trim();
      return hash || null;
    } catch (error) {
      logger.error({ err: error }, 'git: getLastCommitHash failed');
      throw error;
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

// Splits `--pretty` NUL-separated log output into per-commit entries.
function parseLogEntries(output: string): LogEntry[] {
  const parts = output.split('\0');
  const entries: LogEntry[] = [];
  for (let i = 0; i + 3 < parts.length; i += 4) {
    if (!parts[i]) continue;
    entries.push({
      hash: parts[i],
      author: parts[i + 1],
      date: new Date(parts[i + 2]),
      subject: parts[i + 3].split('\n')[0],
    });
  }
  return entries;
}

// Porcelain quotes paths containing special characters (`"a b"`).
function unquotePorcelainPath(path: string): string {
  const trimmed = path.trim();
  if (trimmed.length >= 2 && trimmed.startsWith('"') && trimmed.endsWith('"')) {
    return trimmed.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, '\\');
  }
  return trimmed;
}
