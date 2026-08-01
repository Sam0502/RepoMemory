import { Pool } from 'pg';
import { Commit, FileChange } from '@repo-memory/shared';

export class CommitRepository {
  constructor(private pool: Pool, private repoPath: string = '') {}

  async upsert(commit: Omit<Commit, 'id' | 'createdAt' | 'updatedAt'> & { fileChanges?: FileChange[] }): Promise<Commit> {
    const query = `
      INSERT INTO commits (hash, repo_path, message, author, date, files_changed)
      VALUES ($1, $2, $3, $4, $5, $6)
      ON CONFLICT (hash) DO UPDATE SET
        repo_path = EXCLUDED.repo_path,
        message = EXCLUDED.message,
        author = EXCLUDED.author,
        date = EXCLUDED.date,
        files_changed = EXCLUDED.files_changed
      RETURNING *
    `;
    const values = [
      commit.hash,
      this.repoPath,
      commit.message,
      commit.author,
      commit.date,
      JSON.stringify(commit.filesChanged || []),
    ];
    const result = await this.pool.query(query, values);

    if (commit.fileChanges && commit.fileChanges.length > 0) {
      for (const fc of commit.fileChanges) {
        await this.pool.query(
          `INSERT INTO file_changes (commit_hash, file_path, additions, deletions, status, old_path)
           VALUES ($1, $2, $3, $4, $5, $6)
           ON CONFLICT (commit_hash, file_path) DO UPDATE SET
             additions = EXCLUDED.additions,
             deletions = EXCLUDED.deletions,
             status = EXCLUDED.status,
             old_path = EXCLUDED.old_path`,
          [commit.hash, fc.filePath, fc.additions, fc.deletions, fc.status, fc.oldPath || null]
        );
      }
    }

    return this.mapRowToCommit(result.rows[0]);
  }

  async findByHash(hash: string): Promise<Commit | null> {
    const result = this.repoPath
      ? await this.pool.query('SELECT * FROM commits WHERE hash = $1 AND repo_path = $2', [hash, this.repoPath])
      : await this.pool.query('SELECT * FROM commits WHERE hash = $1', [hash]);
    if (result.rows.length === 0) return null;
    return this.mapRowToCommit(result.rows[0]);
  }

  async findRecent(limit: number = 20): Promise<Commit[]> {
    const result = this.repoPath
      ? await this.pool.query(
          'SELECT * FROM commits WHERE repo_path = $1 ORDER BY date DESC LIMIT $2',
          [this.repoPath, limit]
        )
      : await this.pool.query('SELECT * FROM commits ORDER BY date DESC LIMIT $1', [limit]);
    return result.rows.map(this.mapRowToCommit);
  }

  async getFileChanges(commitHash: string): Promise<FileChange[]> {
    const result = await this.pool.query(
      'SELECT * FROM file_changes WHERE commit_hash = $1 ORDER BY file_path',
      [commitHash]
    );
    return result.rows.map(row => ({
      filePath: row.file_path,
      additions: row.additions,
      deletions: row.deletions,
      status: row.status as FileChange['status'],
      oldPath: row.old_path || undefined,
    }));
  }

  async getLastCommitForRepo(repoPath: string): Promise<string | null> {
    const result = await this.pool.query(
      `SELECT hash FROM commits WHERE repo_path = $1 ORDER BY date DESC LIMIT 1`,
      [repoPath]
    );
    return result.rows[0]?.hash || null;
  }

  async findCommitsForFile(filePath: string, limit: number = 10): Promise<Commit[]> {
    const normalized = filePath.replace(/\\/g, '/');
    const result = await this.pool.query(
      `SELECT c.* FROM commits c
       JOIN file_changes f ON f.commit_hash = c.hash
       WHERE c.repo_path = $1 AND f.file_path = $2
       ORDER BY c.date DESC LIMIT $3`,
      [this.repoPath, normalized, limit]
    );
    return result.rows.map(this.mapRowToCommit);
  }

  async deleteByHash(hash: string): Promise<void> {
    const query = this.repoPath
      ? 'DELETE FROM commits WHERE hash = $1 AND repo_path = $2'
      : 'DELETE FROM commits WHERE hash = $1';
    await this.pool.query(query, this.repoPath ? [hash, this.repoPath] : [hash]);
  }

  private mapRowToCommit(row: any): Commit {
    return {
      hash: row.hash,
      message: row.message,
      author: row.author,
      date: row.date,
      filesChanged: Array.isArray(row.files_changed) ? row.files_changed : [],
    };
  }
}
