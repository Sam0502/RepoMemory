import { Pool } from 'pg';
import { Commit, FileChange } from '@repo-memory/shared';

export class CommitRepository {
  constructor(private pool: Pool) {}

  async upsert(commit: Omit<Commit, 'id' | 'createdAt' | 'updatedAt'> & { fileChanges?: FileChange[] }): Promise<Commit> {
    const query = `
      INSERT INTO commits (hash, message, author, date, files_changed)
      VALUES ($1, $2, $3, $4, $5)
      ON CONFLICT (hash) DO UPDATE SET
        message = EXCLUDED.message,
        author = EXCLUDED.author,
        date = EXCLUDED.date,
        files_changed = EXCLUDED.files_changed
      RETURNING *
    `;
    const values = [
      commit.hash,
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
           ON CONFLICT DO NOTHING`,
          [commit.hash, fc.filePath, fc.additions, fc.deletions, fc.status, fc.oldPath || null]
        );
      }
    }

    return this.mapRowToCommit(result.rows[0]);
  }

  async findByHash(hash: string): Promise<Commit | null> {
    const result = await this.pool.query('SELECT * FROM commits WHERE hash = $1', [hash]);
    if (result.rows.length === 0) return null;
    return this.mapRowToCommit(result.rows[0]);
  }

  async findRecent(limit: number = 20): Promise<Commit[]> {
    const result = await this.pool.query(
      'SELECT * FROM commits ORDER BY date DESC LIMIT $1',
      [limit]
    );
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
      `SELECT hash FROM commits ORDER BY date DESC LIMIT 1`
    );
    return result.rows[0]?.hash || null;
  }

  async deleteByHash(hash: string): Promise<void> {
    await this.pool.query('DELETE FROM commits WHERE hash = $1', [hash]);
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
