import { describe, it, expect } from 'vitest';
import { JobRepository } from '../src/job-repository.js';
import { JobType } from '@repo-memory/shared';

// Handler registry keyed on a SQL substring; falls back to empty rows so
// unrelated queries never throw.
function createMockPool() {
  const calls: Array<{ text: string; params?: unknown[] }> = [];
  const handlers = new Map<string, (params?: unknown[]) => any>();
  const pool = {
    query: async (text: string, params?: unknown[]) => {
      calls.push({ text, params });
      for (const [pattern, handler] of handlers) {
        if (text.includes(pattern)) return handler(params);
      }
      return { rows: [] };
    },
  };
  return { pool: pool as never, calls, handlers };
}

function jobRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'job-1',
    type: JobType.VERIFY,
    status: 'pending',
    repository_path: 'D:\\repo',
    commit_hash: null,
    files_to_process: [],
    result: null,
    error: null,
    started_at: null,
    completed_at: null,
    created_at: new Date('2026-08-02T10:00:00Z'),
    ...overrides,
  };
}

describe('JobRepository', () => {
  it('creates a pending job and maps the returned row', async () => {
    const { pool, handlers } = createMockPool();
    handlers.set('INSERT INTO jobs', () => ({ rows: [jobRow()] }));

    const repo = new JobRepository(pool);
    const job = await repo.create({ type: JobType.VERIFY, repositoryPath: 'D:\\repo' });

    expect(job.id).toBe('job-1');
    expect(job.type).toBe(JobType.VERIFY);
    expect(job.status).toBe('pending');
    expect(job.repositoryPath).toBe('D:\\repo');
    expect(job.filesToProcess).toEqual([]);
  });

  it('creates a job with commit hash and files', async () => {
    const { pool, handlers, calls } = createMockPool();
    handlers.set('INSERT INTO jobs', () => ({ rows: [jobRow()] }));

    const repo = new JobRepository(pool);
    await repo.create({
      type: JobType.REPAIR,
      repositoryPath: 'D:\\repo',
      commitHash: 'abc123',
      filesToProcess: ['src/a.ts'],
    });

    const params = calls[0].params!;
    expect(params[0]).toBe(JobType.REPAIR);
    expect(params[2]).toBe('abc123');
    expect(params[3]).toBe(JSON.stringify(['src/a.ts']));
  });

  it('marks a job running with a start timestamp', async () => {
    const { pool, calls } = createMockPool();
    const repo = new JobRepository(pool);
    await repo.markRunning('job-1');
    expect(calls[0].text).toContain("status = 'running'");
    expect(calls[0].text).toContain('started_at = NOW()');
    expect(calls[0].params).toEqual(['job-1']);
  });

  it('marks a job completed with a JSON result', async () => {
    const { pool, calls } = createMockPool();
    const repo = new JobRepository(pool);
    await repo.markCompleted('job-1', { ok: true, entityTotal: { pg: 3, graph: 2, delta: 1 } });
    expect(calls[0].text).toContain("status = 'completed'");
    expect(calls[0].text).toContain('completed_at = NOW()');
    expect(calls[0].params![0]).toBe(JSON.stringify({ ok: true, entityTotal: { pg: 3, graph: 2, delta: 1 } }));
    expect(calls[0].params![1]).toBe('job-1');
  });

  it('marks a job failed with an error message', async () => {
    const { pool, calls } = createMockPool();
    const repo = new JobRepository(pool);
    await repo.markFailed('job-1', 'boom');
    expect(calls[0].text).toContain("status = 'failed'");
    expect(calls[0].params).toEqual(['boom', 'job-1']);
  });

  it('finds a job by id and returns null when missing', async () => {
    const { pool, handlers } = createMockPool();
    handlers.set('SELECT * FROM jobs', (params?: unknown[]) =>
      params && params[0] === 'job-1' ? { rows: [jobRow({ status: 'completed' })] } : { rows: [] }
    );

    const repo = new JobRepository(pool);
    const found = await repo.findById('job-1');
    expect(found?.status).toBe('completed');

    const missing = await repo.findById('nope');
    expect(missing).toBeNull();
  });

  it('lists recent jobs ordered by creation', async () => {
    const { pool, handlers } = createMockPool();
    handlers.set('ORDER BY created_at DESC', () => ({
      rows: [jobRow({ id: 'job-2' }), jobRow({ id: 'job-1' })],
    }));

    const repo = new JobRepository(pool);
    const jobs = await repo.findAll(10);
    expect(jobs.map((j) => j.id)).toEqual(['job-2', 'job-1']);
  });

  it('counts active (pending + running) jobs', async () => {
    const { pool, handlers } = createMockPool();
    handlers.set("status IN ('pending', 'running')", () => ({ rows: [{ count: '2' }] }));

    const repo = new JobRepository(pool);
    expect(await repo.countActive()).toBe(2);
  });
});
