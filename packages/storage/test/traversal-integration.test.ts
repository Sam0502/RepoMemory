import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import { Pool } from 'pg';
import { EntityRepository } from '../src/entity-repository.js';
import { RelationshipRepository } from '../src/relationship-repository.js';
import { TraversalService } from '../src/traversal.js';
import { migrate } from '../src/schema.js';
import { EntityType, Language, RelationshipType } from '@repo-memory/shared';

const ADMIN_DB = 'repo_memory';
const TEST_DB = 'repo_memory_traversal';

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

const REPO = '/repo-traversal';

function entity(stableId: string, name: string, repoPath: string = REPO, type: EntityType = EntityType.FUNCTION) {
  return {
    stableId,
    repoPath,
    name,
    type,
    language: Language.TYPESCRIPT,
    filePath: `src/${name}.ts`,
    startLine: 1,
    endLine: 10,
    startColumn: 0,
    endColumn: 1,
    isExported: false,
    isTest: type === EntityType.TEST,
    confidence: 1.0,
  };
}

function rel(sourceId: string, targetId: string, type: RelationshipType, filePath = 'src/a.ts') {
  return { sourceId, targetId, type, filePath, confidence: 1.0 };
}

describe.skipIf(!available)('TraversalService (integration)', () => {
  afterAll(async () => {
    await pool?.end();
  });

  // Chain: a -CALLS-> b -CALLS-> c, plus a -HANDLES-> h, b -EXTENDS-> x,
  // t -TESTS-> b, a cycle c -CALLS-> a, fileA -CONTAINS-> {a, b}, and
  // same-stableId rows in another repo.
  beforeAll(async () => {
    await migrate(pool!);
    await pool!.query('DELETE FROM relationships WHERE repo_path IN ($1, $2)', [REPO, '/other']);
    await pool!.query('DELETE FROM entities WHERE repo_path IN ($1, $2)', [REPO, '/other']);
    const entities = new EntityRepository(pool!, REPO);
    for (const id of ['a', 'b', 'c', 'h', 'x']) {
      await entities.upsert(entity(id, id));
    }
    await entities.upsert(entity('t', 't', REPO, EntityType.TEST));
    await entities.upsert(entity('fileA', 'a.ts', REPO, EntityType.FILE));
    await new EntityRepository(pool!, '/other').upsert(entity('a', 'impostor', '/other'));
    const rels = new RelationshipRepository(pool!, REPO);
    await rels.upsert(rel('a', 'b', RelationshipType.CALLS));
    await rels.upsert(rel('b', 'c', RelationshipType.CALLS));
    await rels.upsert(rel('a', 'h', RelationshipType.HANDLES));
    await rels.upsert(rel('b', 'x', RelationshipType.EXTENDS));
    await rels.upsert(rel('c', 'a', RelationshipType.CALLS));
    await rels.upsert(rel('t', 'b', RelationshipType.TESTS));
    await rels.upsert(rel('fileA', 'a', RelationshipType.CONTAINS));
    await rels.upsert(rel('fileA', 'b', RelationshipType.CONTAINS));
    await new RelationshipRepository(pool!, '/other').upsert(rel('a', 'zzz', RelationshipType.CALLS));
  });

  it('finds 1-hop dependencies with joined entities', async () => {
    const t = new TraversalService(pool!);
    const deps = await t.findDependencies('a', REPO);
    expect(deps.map((d) => d.entity.stableId).sort()).toEqual(['b', 'h']);
    expect(deps[0].relationship.type).toBeDefined();
  });

  it('finds 1-hop dependents, including TESTS edges', async () => {
    const t = new TraversalService(pool!);
    const dependents = await t.findDependents('b', REPO);
    expect(dependents.map((d) => d.entity.stableId).sort()).toEqual(['a', 't']);
  });

  it('limits 1-hop reads and reports totals', async () => {
    const t = new TraversalService(pool!);
    expect(await t.countDependents('b', REPO)).toBe(2);
    expect(await t.countDependencies('a', REPO)).toBe(2);
    const limited = await t.findDependents('b', REPO, 1);
    expect(limited).toHaveLength(1);
    const unlimited = await t.findDependents('b', REPO);
    expect(unlimited).toHaveLength(2);
  });

  it('finds member entities via CONTAINS edges', async () => {
    const t = new TraversalService(pool!);
    const members = await t.findMembers('fileA', REPO);
    expect(members.map((d) => d.entity.stableId).sort()).toEqual(['a', 'b']);
    expect(members[0].relationship.type).toBe('CONTAINS');
  });

  it('scopes reads to the repo (ignores cross-repo stableId collisions)', async () => {
    const t = new TraversalService(pool!);
    const deps = await t.findDependencies('a', REPO);
    expect(deps.every((d) => d.entity.repoPath === REPO)).toBe(true);
  });

  it('walks transitive dependencies and terminates on cycles', async () => {
    const t = new TraversalService(pool!);
    const transitive = await t.findTransitiveDependencies('a', 6, REPO);
    const ids = transitive.map((e) => e.stableId).sort();
    // b (direct), c (via b), h (direct), x (via b, EXTENDS is traversed).
    // a itself is included via the a→b→c→a cycle — same as Cypher *1..depth.
    expect(ids).toEqual(['a', 'b', 'c', 'h', 'x']);
  });

  it('respects the depth cap', async () => {
    const t = new TraversalService(pool!);
    const depth1 = await t.findTransitiveDependencies('a', 1, REPO);
    expect(depth1.map((e) => e.stableId).sort()).toEqual(['b', 'h']);
  });

  it('walks transitive dependents', async () => {
    const t = new TraversalService(pool!);
    const transitive = await t.findTransitiveDependents('c', 6, REPO);
    // c itself is included via the c→a→b→c cycle — same as Cypher *1..depth.
    // t reaches c transitively (t→b→c) since TESTS edges are traversed.
    expect(transitive.map((e) => e.stableId).sort()).toEqual(['a', 'b', 'c', 't']);
  });

  it('finds the shortest path, preferring fewer hops', async () => {
    const t = new TraversalService(pool!);
    // a→c directly via the c→a cycle edge (traversed backwards), not a→b→c.
    const path = await t.findShortestPath('a', 'c', 5, REPO);
    expect(path).not.toBeNull();
    expect(path!.nodes.map((n) => n.stableId)).toEqual(['a', 'c']);
    expect(path!.relationships).toEqual([{ type: 'CALLS', direction: 'in' }]);
  });

  it('finds multi-hop shortest paths', async () => {
    const t = new TraversalService(pool!);
    // h→a (HANDLES, backwards) then a→c (CALLS, backwards via the cycle edge).
    const path = await t.findShortestPath('h', 'c', 5, REPO);
    expect(path).not.toBeNull();
    expect(path!.nodes.map((n) => n.stableId)).toEqual(['h', 'a', 'c']);
    expect(path!.relationships).toEqual([
      { type: 'HANDLES', direction: 'in' },
      { type: 'CALLS', direction: 'in' },
    ]);
  });

  it('walks structural edges in shortest paths', async () => {
    const t = new TraversalService(pool!);
    // h→a→b→x: x only connects via EXTENDS, which traversal walks.
    const path = await t.findShortestPath('h', 'x', 6, REPO);
    expect(path).not.toBeNull();
    expect(path!.nodes.map((n) => n.stableId)).toEqual(['h', 'a', 'b', 'x']);
    expect(path!.relationships).toEqual([
      { type: 'HANDLES', direction: 'in' },
      { type: 'CALLS', direction: 'out' },
      { type: 'EXTENDS', direction: 'out' },
    ]);
  });

  it('returns null when the target is unreachable', async () => {
    const t = new TraversalService(pool!);
    await expect(t.findShortestPath('h', 'nonexistent', 5, REPO)).resolves.toBeNull();
  });
});
