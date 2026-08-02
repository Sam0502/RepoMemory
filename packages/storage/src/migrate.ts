#!/usr/bin/env node

import { createPool, migrate } from './index.js';
import { getLogger } from '@repo-memory/shared';

const logger = getLogger({ component: 'storage' });

const DB_CONFIG = {
  host: process.env.PG_HOST || 'localhost',
  port: parseInt(process.env.PG_PORT || '5433', 10),
  database: process.env.PG_DATABASE || 'repo_memory',
  user: process.env.PG_USER || 'repo_memory',
  password: process.env.PG_PASSWORD || 'repo-memory-password',
};

async function main(): Promise<void> {
  const pool = await createPool(DB_CONFIG);
  try {
    const applied = await migrate(pool);
    if (applied.length === 0) {
      logger.info('Schema is up to date (0 pending migrations).');
    } else {
      logger.info({ count: applied.length }, 'Applied pending migrations');
    }
  } finally {
    await pool.end();
  }
}

main().catch((error) => {
  logger.error({ err: error }, 'Migration failed');
  process.exit(1);
});
