import { describe, it, expect } from 'vitest';
import { MigrationRunner } from '../src/migrations/runner.js';
import { migrations } from '../src/migrations/index.js';

describe('migrations registry', () => {
  it('defines ordered, unique, contiguous migration ids', () => {
    expect(migrations.length).toBeGreaterThan(0);
    const ids = migrations.map((m) => m.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect([...ids].sort((a, b) => a - b)).toEqual(ids);
  });

  it('defines named migrations with an up function', () => {
    for (const migration of migrations) {
      expect(migration.name).toBeTruthy();
      expect(typeof migration.up).toBe('function');
    }
  });
});

describe('MigrationRunner', () => {
  function createMockPool(existingIds: number[]) {
    const executed: { id: number; name: string }[] = [];
    const client = {
      release: () => {},
      query: async (text: string, params?: unknown[]) => {
        if (text.includes('SELECT id FROM schema_migrations')) {
          return { rows: existingIds.map((id) => ({ id })) };
        }
        if (text.trim().startsWith('INSERT INTO schema_migrations')) {
          executed.push({ id: params?.[0] as number, name: params?.[1] as string });
        }
        return { rows: [] };
      },
    };
    return {
      pool: { connect: async () => client },
      client,
      executed,
    };
  }

  it('applies only pending migrations in order', async () => {
    const { pool, executed } = createMockPool([]);
    const runner = new MigrationRunner(pool as never, migrations);
    const applied = await runner.run();
    expect(applied.map((m) => m.id)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(executed.map((m) => m.id)).toEqual([1, 2, 3, 4, 5, 6, 7]);
  });

  it('skips already-applied migrations and is a no-op when fully migrated', async () => {
    const { pool, executed } = createMockPool([1, 2, 3, 4, 5, 6, 7]);
    const runner = new MigrationRunner(pool as never, migrations);
    const applied = await runner.run();
    expect(applied).toEqual([]);
    expect(executed).toEqual([]);
  });

  it('applies only the migrations missing from the ledger', async () => {
    const { pool, executed } = createMockPool([1, 2]);
    const runner = new MigrationRunner(pool as never, migrations);
    const applied = await runner.run();
    expect(applied.map((m) => m.id)).toEqual([3, 4, 5, 6, 7]);
    expect(executed.map((m) => m.id)).toEqual([3, 4, 5, 6, 7]);
  });
});
