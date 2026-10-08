import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Pool } from 'pg';
import { createApp } from '../src/server.js';
import { EntityRepository, RelationshipRepository, TraversalService, MigrationRunner, migrations } from '@repo-memory/storage';
import { EntityType, Language, RelationshipType } from '@repo-memory/shared';

const ADMIN_DB = 'repo_memory';
const TEST_DB = 'repo_memory_api_test';

const baseConfig = {
  host: process.env.PG_HOST || 'localhost',
  port: parseInt(process.env.PG_PORT || '5433', 10),
  user: process.env.PG_USER || 'repo_memory',
  password: process.env.PG_PASSWORD || 'repo-memory-password',
};

let available = false;
let pool: Pool | undefined;
let repoDir: string | undefined;

try {
  const admin = new Pool({ ...baseConfig, database: ADMIN_DB });
  const { rows } = await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', [TEST_DB]);
  if (rows.length === 0) {
    await admin.query(`CREATE DATABASE ${TEST_DB}`);
  }
  await admin.end();

  pool = new Pool({ ...baseConfig, database: TEST_DB });
  await pool.query('SELECT 1');
  const runner = new MigrationRunner(pool, migrations);
  await runner.run();
  available = true;
} catch {
  available = false;
}

const STABLE_ID = 'api-test:fn';

describe.skipIf(!available)('entity source + members endpoints (integration)', () => {
  afterAll(async () => {
    await pool?.end();
    if (repoDir) rmSync(repoDir, { recursive: true, force: true });
  });

  beforeAll(async () => {
    repoDir = mkdtempSync(join(tmpdir(), 'api-source-'));
    writeFileSync(join(repoDir, 'a.ts'), 'export function hello() {\n  return 1;\n}\n');
    const entities = new EntityRepository(pool!, repoDir);
    await entities.upsert({
      stableId: 'api-test:file',
      name: 'a.ts',
      type: EntityType.FILE,
      language: Language.TYPESCRIPT,
      filePath: 'a.ts',
      startLine: 1,
      endLine: 3,
      startColumn: 0,
      endColumn: 1,
      isExported: false,
      isTest: false,
      confidence: 1.0,
    });
    await entities.upsert({
      stableId: STABLE_ID,
      name: 'hello',
      type: EntityType.FUNCTION,
      language: Language.TYPESCRIPT,
      filePath: 'a.ts',
      startLine: 1,
      endLine: 3,
      startColumn: 0,
      endColumn: 1,
      isExported: true,
      isTest: false,
      confidence: 1.0,
    });
    await new RelationshipRepository(pool!, repoDir).upsert({
      sourceId: 'api-test:file',
      targetId: STABLE_ID,
      type: RelationshipType.CONTAINS,
      filePath: 'a.ts',
      confidence: 1.0,
    });
  });

  function makeApp() {
    return createApp({
      port: 0,
      host: 'localhost',
      repoPath: repoDir!,
      traversal: new TraversalService(pool!),
      pgPool: pool!,
    });
  }

  it('returns exact source lines', async () => {
    const res = await makeApp().request(`/api/entities/${STABLE_ID}/source`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.source).toBe('export function hello() {\n  return 1;\n}');
    expect(body.totalLines).toBe(4);
    expect(body.truncated).toBe(false);
  });

  it('404s on unknown entities', async () => {
    const res = await makeApp().request('/api/entities/nope/source');
    expect(res.status).toBe(404);
  });

  it('lists member entities', async () => {
    const res = await makeApp().request('/api/entities/api-test:file/members');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.count).toBe(1);
    expect(body.total).toBe(1);
    expect(body.members[0].stableId).toBe(STABLE_ID);
  });

  it('reports totals on dependency endpoints', async () => {
    const res = await makeApp().request(`/api/graph/dependents/${STABLE_ID}`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.total).toBe(0);
    expect(body.dependents).toEqual([]);
  });
});
