import { Pool } from 'pg';
import { MigrationRunner } from './migrations/runner.js';
import { migrations } from './migrations/index.js';
import type { MigrationResult } from './migrations/runner.js';
import { getLogger } from '@repo-memory/shared';

const logger = getLogger({ component: 'storage' });

export async function migrate(pool: Pool): Promise<MigrationResult[]> {
  logger.info('Running database migrations...');
  const runner = new MigrationRunner(pool, migrations);
  const applied = await runner.run();
  if (applied.length === 0) {
    logger.info('Database schema is up to date.');
  } else {
    for (const migration of applied) {
      logger.info({ migration: `${migration.id}-${migration.name}` }, 'Applied migration');
    }
  }
  logger.info('Database migration completed.');
  return applied;
}

export async function createPool(config: {
  host: string;
  port: number;
  database: string;
  user: string;
  password: string;
}): Promise<Pool> {
  const pool = new Pool(config);

  // Test connection
  try {
    await pool.query('SELECT 1');
    logger.info('Database connection successful.');
  } catch (error) {
    logger.error({ err: error }, 'Database connection failed');
    throw error;
  }

  return pool;
}
