import type { Pool, PoolClient } from 'pg';

export interface Migration {
  id: number;
  name: string;
  up: (client: PoolClient) => Promise<void>;
}

export interface MigrationResult {
  id: number;
  name: string;
  appliedAt: Date;
}

const SCHEMA_MIGRATIONS_SQL = `
CREATE TABLE IF NOT EXISTS schema_migrations (
  id INTEGER PRIMARY KEY,
  name VARCHAR(255) NOT NULL,
  applied_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
)
`;

export class MigrationRunner {
  constructor(
    private readonly pool: Pool,
    private readonly migrations: Migration[]
  ) {}

  async run(): Promise<MigrationResult[]> {
    const client = await this.pool.connect();
    const applied: MigrationResult[] = [];
    try {
      await client.query(SCHEMA_MIGRATIONS_SQL);

      const { rows } = await client.query<{ id: number }>('SELECT id FROM schema_migrations');
      const appliedIds = new Set(rows.map((row) => row.id));

      for (const migration of this.migrations) {
        if (appliedIds.has(migration.id)) continue;

        await client.query('BEGIN');
        try {
          await migration.up(client);
          await client.query('INSERT INTO schema_migrations (id, name) VALUES ($1, $2)', [
            migration.id,
            migration.name,
          ]);
          await client.query('COMMIT');
          applied.push({ id: migration.id, name: migration.name, appliedAt: new Date() });
        } catch (error) {
          await client.query('ROLLBACK');
          throw new Error(
            `Migration ${migration.id}-${migration.name} failed: ${(error as Error).message}`
          );
        }
      }

      return applied;
    } finally {
      client.release();
    }
  }
}
