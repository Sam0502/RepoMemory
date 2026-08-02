import { Pool } from 'pg';
import { Job, JobType, JobStatus } from '@repo-memory/shared';

export class JobRepository {
  constructor(private pool: Pool) {}

  async create(job: {
    type: JobType;
    repositoryPath: string;
    commitHash?: string;
    filesToProcess?: string[];
  }): Promise<Job> {
    const query = `
      INSERT INTO jobs (type, status, repository_path, commit_hash, files_to_process)
      VALUES ($1, 'pending', $2, $3, $4)
      RETURNING *
    `;
    const result = await this.pool.query(query, [
      job.type,
      job.repositoryPath,
      job.commitHash || null,
      JSON.stringify(job.filesToProcess || []),
    ]);
    return this.mapRowToJob(result.rows[0]);
  }

  async markRunning(id: string): Promise<void> {
    await this.pool.query(
      `UPDATE jobs SET status = 'running', started_at = NOW() WHERE id = $1`,
      [id]
    );
  }

  async markCompleted(id: string, result: unknown): Promise<void> {
    await this.pool.query(
      `UPDATE jobs SET status = 'completed', result = $1::jsonb, completed_at = NOW() WHERE id = $2`,
      [JSON.stringify(result), id]
    );
  }

  async markFailed(id: string, error: string): Promise<void> {
    await this.pool.query(
      `UPDATE jobs SET status = 'failed', error = $1, completed_at = NOW() WHERE id = $2`,
      [error, id]
    );
  }

  async findById(id: string): Promise<Job | null> {
    const result = await this.pool.query('SELECT * FROM jobs WHERE id = $1', [id]);
    return result.rows[0] ? this.mapRowToJob(result.rows[0]) : null;
  }

  async findAll(limit: number = 50, offset: number = 0): Promise<Job[]> {
    const result = await this.pool.query(
      'SELECT * FROM jobs ORDER BY created_at DESC LIMIT $1 OFFSET $2',
      [limit, offset]
    );
    return result.rows.map(this.mapRowToJob);
  }

  async findByType(type: JobType, limit: number = 50): Promise<Job[]> {
    const result = await this.pool.query(
      'SELECT * FROM jobs WHERE type = $1 ORDER BY created_at DESC LIMIT $2',
      [type, limit]
    );
    return result.rows.map(this.mapRowToJob);
  }

  // Pending + running jobs form the "queue" whose depth is surfaced as a metric.
  async countActive(): Promise<number> {
    const result = await this.pool.query(
      "SELECT COUNT(*) as count FROM jobs WHERE status IN ('pending', 'running')"
    );
    return parseInt(result.rows[0].count);
  }

  private mapRowToJob(row: any): Job {
    return {
      id: row.id,
      type: row.type as JobType,
      status: row.status as JobStatus,
      repositoryPath: row.repository_path,
      commitHash: row.commit_hash,
      filesToProcess: row.files_to_process || [],
      result: row.result,
      error: row.error,
      startedAt: row.started_at,
      completedAt: row.completed_at,
      createdAt: row.created_at,
    };
  }
}
