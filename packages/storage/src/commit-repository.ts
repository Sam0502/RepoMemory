import { Pool } from 'pg';
import { Commit, FileChange, FileChurnRow } from '@repo-memory/shared';

export class CommitRepository {
  constructor(private pool: Pool, private repoPath: string = '') {}

  async upsert(commit: Omit<Commit, 'id' | 'createdAt' | 'updatedAt'> & { fileChanges?: FileChange[] }): Promise<Commit> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');

      const query = `
        INSERT INTO commits (hash, repo_path, message, author, date, files_changed)
        VALUES ($1, $2, $3, $4, $5, $6)
        ON CONFLICT (repo_path, hash) DO UPDATE SET
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
      const result = await client.query(query, values);

      // Batch all file changes in a single statement, inside the same
      // transaction as the commit row for atomicity.
      const fileChanges = commit.fileChanges || [];
      if (fileChanges.length > 0) {
        const params: unknown[] = [];
        const clauses = fileChanges.map((_, i) => {
          const base = i * 7;
          params.push(
            commit.hash,
            this.repoPath,
            fileChanges[i].filePath,
            fileChanges[i].additions,
            fileChanges[i].deletions,
            fileChanges[i].status,
            fileChanges[i].oldPath || null
          );
          return `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, $${base + 6}, $${base + 7})`;
        });
        await client.query(
          `INSERT INTO file_changes (commit_hash, repo_path, file_path, additions, deletions, status, old_path)
           VALUES ${clauses.join(', ')}
           ON CONFLICT (repo_path, commit_hash, file_path) DO UPDATE SET
             additions = EXCLUDED.additions,
             deletions = EXCLUDED.deletions,
             status = EXCLUDED.status,
             old_path = EXCLUDED.old_path`,
          params
        );
      }

      await client.query('COMMIT');
      return this.mapRowToCommit(result.rows[0]);
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async findByHash(hash: string): Promise<Commit | null> {
    const result = this.repoPath
      ? await this.pool.query('SELECT * FROM commits WHERE hash = $1 AND repo_path = $2', [hash, this.repoPath])
      : await this.pool.query('SELECT * FROM commits WHERE hash = $1 ORDER BY date DESC LIMIT 1', [hash]);
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
    const result = this.repoPath
      ? await this.pool.query(
          'SELECT * FROM file_changes WHERE commit_hash = $1 AND repo_path = $2 ORDER BY file_path',
          [commitHash, this.repoPath]
        )
      : await this.pool.query(
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

  async getLastCommitDate(repoPath: string): Promise<Date | null> {
    const result = await this.pool.query(
      `SELECT date FROM commits WHERE repo_path = $1 ORDER BY date DESC LIMIT 1`,
      [repoPath]
    );
    return result.rows[0]?.date ? new Date(result.rows[0].date) : null;
  }

  async getFileChurn(repoPath: string, limit: number = 50, days?: number): Promise<FileChurnRow[]> {
    const query = days
      ? `SELECT f.file_path,
                COUNT(*)::int AS commits,
                COALESCE(SUM(f.additions), 0)::int AS additions,
                COALESCE(SUM(f.deletions), 0)::int AS deletions,
                MAX(c.date) AS last_changed
         FROM file_changes f
         JOIN commits c ON c.hash = f.commit_hash AND c.repo_path = f.repo_path
         WHERE c.repo_path = $1 AND c.date >= NOW() - make_interval(days => $2)
         GROUP BY f.file_path
         ORDER BY commits DESC
         LIMIT $3`
      : `SELECT f.file_path,
                COUNT(*)::int AS commits,
                COALESCE(SUM(f.additions), 0)::int AS additions,
                COALESCE(SUM(f.deletions), 0)::int AS deletions,
                MAX(c.date) AS last_changed
         FROM file_changes f
         JOIN commits c ON c.hash = f.commit_hash AND c.repo_path = f.repo_path
         WHERE c.repo_path = $1
         GROUP BY f.file_path
         ORDER BY commits DESC
         LIMIT $2`;
    const result = await this.pool.query(query, days ? [repoPath, days, limit] : [repoPath, limit]);
    return result.rows.map(row => ({
      filePath: row.file_path,
      commits: parseInt(row.commits),
      additions: parseInt(row.additions),
      deletions: parseInt(row.deletions),
      lastChanged: new Date(row.last_changed),
    }));
  }

  async findCommitsForFile(filePath: string, limit: number = 10): Promise<Commit[]> {
    const normalized = filePath.replace(/\\/g, '/');
    const query = this.repoPath
      ? `SELECT c.* FROM commits c
         JOIN file_changes f ON f.commit_hash = c.hash AND f.repo_path = c.repo_path
         WHERE c.repo_path = $1 AND f.file_path = $2
         ORDER BY c.date DESC LIMIT $3`
      : `SELECT c.* FROM commits c
         JOIN file_changes f ON f.commit_hash = c.hash AND f.repo_path = c.repo_path
         WHERE f.file_path = $1
         ORDER BY c.date DESC LIMIT $2`;
    const result = await this.pool.query(query, this.repoPath ? [this.repoPath, normalized, limit] : [normalized, limit]);
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
      repoPath: row.repo_path,
      message: row.message,
      author: row.author,
      date: row.date,
      filesChanged: Array.isArray(row.files_changed) ? row.files_changed : [],
    };
  }
}
