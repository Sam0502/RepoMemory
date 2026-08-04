import { describe, it, expect, afterAll } from 'vitest';
import { Pool } from 'pg';
import { MigrationRunner } from '../src/migrations/runner.js';
import { migrations } from '../src/migrations/index.js';

const ADMIN_DB = 'repo_memory';
const TEST_DB = 'repo_memory_test';

const baseConfig = {
  host: process.env.PG_HOST || 'localhost',
  port: parseInt(process.env.PG_PORT || '5433', 10),
  user: process.env.PG_USER || 'repo_memory',
  password: process.env.PG_PASSWORD || 'repo-memory-password',
};

let available = false;
let pool: Pool | undefined;

try {
  const admin = new Pool({ ...baseConfig, database: ADMIN_DB });
  const { rows } = await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', [TEST_DB]);
  if (rows.length === 0) {
    await admin.query(`CREATE DATABASE ${TEST_DB}`);
  }
  await admin.end();

  pool = new Pool({ ...baseConfig, database: TEST_DB });
  await pool.query('SELECT 1');
  available = true;
} catch {
  available = false;
}

describe.skipIf(!available)('schema migrations (integration)', () => {
  afterAll(async () => {
    await pool?.end();
  });

  it('applies all pending migrations to a fresh database and records them in schema_migrations', async () => {
    await pool!.query('DROP SCHEMA public CASCADE');
    await pool!.query('CREATE SCHEMA public');

    const runner = new MigrationRunner(pool!, migrations);
    const applied = await runner.run();

    expect(applied.map((m) => m.id)).toEqual([1, 2, 3, 4, 5]);

    const { rows: ledger } = await pool!.query(
      'SELECT id, name FROM schema_migrations ORDER BY id'
    );
    expect(ledger).toEqual([
      { id: 1, name: 'init' },
      { id: 2, name: 'repo-path-scoping' },
      { id: 3, name: 'embeddings' },
      { id: 4, name: 'id-lengths' },
      { id: 5, name: 'commit-repo-scoping' },
    ]);

    const { rows: tables } = await pool!.query(
      "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'"
    );
    const names = tables.map((t) => t.table_name);
    for (const expected of ['entities', 'relationships', 'commits', 'file_changes', 'jobs', 'repo_state']) {
      expect(names).toContain(expected);
    }
  });

  it('produces the current schema shape (repo_path, embeddings, expanded ids)', async () => {
    const entityColumns = await pool!.query(
      "SELECT column_name FROM information_schema.columns WHERE table_name = 'entities'"
    );
    const entityNames = entityColumns.rows.map((c) => c.column_name);
    expect(entityNames).toContain('repo_path');
    expect(entityNames).toContain('embedding');

    const relColumns = await pool!.query(
      "SELECT column_name, character_maximum_length FROM information_schema.columns WHERE table_name = 'relationships'"
    );
    const relMap = new Map(relColumns.rows.map((c) => [c.column_name, c.character_maximum_length]));
    expect(relMap.get('repo_path')).toBe(1000);
    expect(relMap.get('source_id')).toBe(1000);
    expect(relMap.get('target_id')).toBe(1000);

    const { rows: constraints } = await pool!.query(
      `SELECT conname FROM pg_constraint
       WHERE conrelid = 'relationships'::regclass
         AND conname = 'relationships_repo_path_source_id_target_id_type_file_path_key'`
    );
    expect(constraints).toHaveLength(1);
  });

  it('is a no-op when run again against an already-migrated database', async () => {
    const runner = new MigrationRunner(pool!, migrations);
    const applied = await runner.run();
    expect(applied).toEqual([]);
  });
});
