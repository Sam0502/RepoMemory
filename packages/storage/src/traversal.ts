import { Pool } from 'pg';
import { Entity, EntityType, Language, Relationship, RelationshipType } from '@repo-memory/shared';

// Edge types walked for dependency / dependent / impact queries. EXTENDS,
// IMPLEMENTS, and TESTS are included so impact analysis sees implementors,
// subclasses, and covering tests (the pre-Neo4j-removal filter was narrower).
const TRAVERSAL_TYPES: RelationshipType[] = [
  RelationshipType.IMPORTS,
  RelationshipType.DEPENDS_ON,
  RelationshipType.CALLS,
  RelationshipType.REFERENCES,
  RelationshipType.HANDLES,
  RelationshipType.EXTENDS,
  RelationshipType.IMPLEMENTS,
  RelationshipType.TESTS,
];

// Shortest-path walks the same edges plus structural ones (undirected),
// mirroring the old shortestPath Cypher filter (+CONTAINS|EXPORTS).
const PATH_TYPES: RelationshipType[] = [
  ...TRAVERSAL_TYPES,
  RelationshipType.CONTAINS,
  RelationshipType.EXPORTS,
];

const MAX_TRAVERSAL_DEPTH = 6;

function clampDepth(maxDepth: number): number {
  if (!Number.isInteger(maxDepth) || maxDepth < 1) return 1;
  return Math.min(maxDepth, MAX_TRAVERSAL_DEPTH);
}

// Appends a LIMIT clause for a validated limit, pushing the value onto the
// params array. Evaluated inline in the query template before the query runs.
function limitTail(params: unknown[], limit?: number): string {
  if (!Number.isInteger(limit) || (limit as number) <= 0) return '';
  params.push(limit);
  return ` LIMIT $${params.length}`;
}

export interface TraversalPath {
  nodes: Entity[];
  relationships: Array<{ type: string; direction: 'out' | 'in' }>;
}

// PostgreSQL-backed graph traversal. Replaces the Neo4j GraphClient read API
// with single-statement recursive CTEs over the `relationships` table, so the
// engine runs on one store (no dual-write, no reconcile jobs).
export class TraversalService {
  constructor(private pool: Pool) {}

  async findDependencies(
    stableId: string,
    repoPath?: string,
    limit?: number
  ): Promise<Array<{ entity: Entity; relationship: Relationship }>> {
    const { where, params } = this.edgeFilter('r.source_id = $1', TRAVERSAL_TYPES, repoPath, [stableId]);
    const result = await this.pool.query(
      `SELECT ${ENTITY_COLS}, ${REL_COLS}
       FROM relationships r
       JOIN entities e ON e.stable_id = r.target_id${repoPath ? ' AND e.repo_path = r.repo_path' : ''}
       WHERE ${where}
       ORDER BY e.name${limitTail(params, limit)}`,
      params
    );
    return result.rows.map((row) => ({
      entity: mapRowToEntity(row),
      relationship: mapRowToRelationship(row),
    }));
  }

  async findDependents(
    stableId: string,
    repoPath?: string,
    limit?: number
  ): Promise<Array<{ entity: Entity; relationship: Relationship }>> {
    const { where, params } = this.edgeFilter('r.target_id = $1', TRAVERSAL_TYPES, repoPath, [stableId]);
    const result = await this.pool.query(
      `SELECT ${ENTITY_COLS}, ${REL_COLS}
       FROM relationships r
       JOIN entities e ON e.stable_id = r.source_id${repoPath ? ' AND e.repo_path = r.repo_path' : ''}
       WHERE ${where}
       ORDER BY e.name${limitTail(params, limit)}`,
      params
    );
    return result.rows.map((row) => ({
      entity: mapRowToEntity(row),
      relationship: mapRowToRelationship(row),
    }));
  }

  // Member entities contained in a class, file, or other parent (CONTAINS
  // edges): methods of a class, top-level symbols of a file.
  async findMembers(
    stableId: string,
    repoPath?: string,
    limit?: number
  ): Promise<Array<{ entity: Entity; relationship: Relationship }>> {
    const { where, params } = this.edgeFilter(
      'r.source_id = $1',
      [RelationshipType.CONTAINS],
      repoPath,
      [stableId]
    );
    const result = await this.pool.query(
      `SELECT ${ENTITY_COLS}, ${REL_COLS}
       FROM relationships r
       JOIN entities e ON e.stable_id = r.target_id${repoPath ? ' AND e.repo_path = r.repo_path' : ''}
       WHERE ${where}
       ORDER BY e.name${limitTail(params, limit)}`,
      params
    );
    return result.rows.map((row) => ({
      entity: mapRowToEntity(row),
      relationship: mapRowToRelationship(row),
    }));
  }

  // Totals behind the (optionally limited) 1-hop reads, so callers can report
  // "showing 20 of N" instead of silently truncating hubs.
  async countDependencies(stableId: string, repoPath?: string): Promise<number> {
    const { where, params } = this.edgeFilter('r.source_id = $1', TRAVERSAL_TYPES, repoPath, [stableId]);
    const result = await this.pool.query(
      `SELECT COUNT(*) AS count FROM relationships r WHERE ${where}`,
      params
    );
    return parseInt(result.rows[0].count, 10);
  }

  async countDependents(stableId: string, repoPath?: string): Promise<number> {
    const { where, params } = this.edgeFilter('r.target_id = $1', TRAVERSAL_TYPES, repoPath, [stableId]);
    const result = await this.pool.query(
      `SELECT COUNT(*) AS count FROM relationships r WHERE ${where}`,
      params
    );
    return parseInt(result.rows[0].count, 10);
  }

  async countMembers(stableId: string, repoPath?: string): Promise<number> {
    const { where, params } = this.edgeFilter(
      'r.source_id = $1',
      [RelationshipType.CONTAINS],
      repoPath,
      [stableId]
    );
    const result = await this.pool.query(
      `SELECT COUNT(*) AS count FROM relationships r WHERE ${where}`,
      params
    );
    return parseInt(result.rows[0].count, 10);
  }

  async findTransitiveDependencies(
    stableId: string,
    maxDepth: number = 5,
    repoPath?: string,
    limit?: number
  ): Promise<Entity[]> {
    const depth = clampDepth(maxDepth);
    const { typeList, params, repoClause, nextParam } = this.walkFilter(TRAVERSAL_TYPES, repoPath, [stableId]);
    if (repoPath) params.push(depth, repoPath);
    else params.push(depth);
    const result = await this.pool.query(
      `WITH RECURSIVE walk(stable_id, depth) AS (
         SELECT r.target_id, 1
         FROM relationships r
         WHERE r.source_id = $1 AND ${typeList}${repoClause('r')}
         UNION
         SELECT r.target_id, w.depth + 1
         FROM relationships r
         JOIN walk w ON r.source_id = w.stable_id
         WHERE w.depth < $${nextParam} AND ${typeList}${repoClause('r')}
       )
       SELECT DISTINCT e.*
       FROM walk w
       JOIN entities e ON e.stable_id = w.stable_id${repoPath ? ' AND e.repo_path = $' + (nextParam + 1) : ''}
       ORDER BY e.name${limitTail(params, limit)}`,
      params
    );
    return result.rows.map(mapRowToEntity);
  }

  async findTransitiveDependents(
    stableId: string,
    maxDepth: number = 5,
    repoPath?: string,
    limit?: number
  ): Promise<Entity[]> {
    const depth = clampDepth(maxDepth);
    const { typeList, params, repoClause, nextParam } = this.walkFilter(TRAVERSAL_TYPES, repoPath, [stableId]);
    if (repoPath) params.push(depth, repoPath);
    else params.push(depth);
    const result = await this.pool.query(
      `WITH RECURSIVE walk(stable_id, depth) AS (
         SELECT r.source_id, 1
         FROM relationships r
         WHERE r.target_id = $1 AND ${typeList}${repoClause('r')}
         UNION
         SELECT r.source_id, w.depth + 1
         FROM relationships r
         JOIN walk w ON r.target_id = w.stable_id
         WHERE w.depth < $${nextParam} AND ${typeList}${repoClause('r')}
       )
       SELECT DISTINCT e.*
       FROM walk w
       JOIN entities e ON e.stable_id = w.stable_id${repoPath ? ' AND e.repo_path = $' + (nextParam + 1) : ''}
       ORDER BY e.name${limitTail(params, limit)}`,
      params
    );
    return result.rows.map(mapRowToEntity);
  }

  // Undirected shortest path between two entities (BFS via a recursive CTE
  // with a visited-node guard, so cycles terminate). Returns null when the
  // target is unreachable within maxDepth hops.
  async findShortestPath(
    sourceId: string,
    targetId: string,
    maxDepth: number = 5,
    repoPath?: string
  ): Promise<TraversalPath | null> {
    const depth = clampDepth(maxDepth);
    if (sourceId === targetId) {
      const self = await this.pool.query(
        repoPath
          ? 'SELECT * FROM entities WHERE stable_id = $1 AND repo_path = $2'
          : 'SELECT * FROM entities WHERE stable_id = $1',
        repoPath ? [sourceId, repoPath] : [sourceId]
      );
      if (self.rows.length === 0) return null;
      return { nodes: [mapRowToEntity(self.rows[0])], relationships: [] };
    }

    const { typeList, params, repoClause, nextParam } = this.walkFilter(PATH_TYPES, repoPath, [sourceId, targetId]);
    const result = await this.pool.query(
      `WITH RECURSIVE path(node, depth, nodes, edges) AS (
         SELECT
           CASE WHEN r.source_id = $1 THEN r.target_id ELSE r.source_id END,
           1,
           ARRAY[$1, CASE WHEN r.source_id = $1 THEN r.target_id ELSE r.source_id END],
           ARRAY[r.type || ':' || CASE WHEN r.source_id = $1 THEN 'out' ELSE 'in' END]
         FROM relationships r
         WHERE (r.source_id = $1 OR r.target_id = $1) AND ${typeList}${repoClause('r')}
         UNION
         SELECT
           CASE WHEN r.source_id = p.node THEN r.target_id ELSE r.source_id END,
           p.depth + 1,
           p.nodes || CASE WHEN r.source_id = p.node THEN r.target_id ELSE r.source_id END,
           p.edges || (r.type || ':' || CASE WHEN r.source_id = p.node THEN 'out' ELSE 'in' END)
         FROM relationships r
         JOIN path p ON (r.source_id = p.node OR r.target_id = p.node)
         WHERE p.depth < $${nextParam}
           AND NOT ((CASE WHEN r.source_id = p.node THEN r.target_id ELSE r.source_id END) = ANY(p.nodes))
           AND ${typeList}${repoClause('r')}
       )
       SELECT nodes, edges FROM path WHERE node = $2 ORDER BY depth LIMIT 1`,
      repoPath ? [...params, depth, repoPath] : [...params, depth]
    );
    if (result.rows.length === 0) return null;

    const nodeIds: string[] = result.rows[0].nodes;
    const edgeSpecs: string[] = result.rows[0].edges;
    const entities = await this.pool.query(
      repoPath
        ? 'SELECT * FROM entities WHERE stable_id = ANY($1) AND repo_path = $2'
        : 'SELECT * FROM entities WHERE stable_id = ANY($1)',
      repoPath ? [nodeIds, repoPath] : [nodeIds]
    );
    const byId = new Map(entities.rows.map((row) => [row.stable_id as string, mapRowToEntity(row)]));
    const nodes = nodeIds.map((id) => byId.get(id)).filter((e): e is Entity => Boolean(e));
    if (nodes.length === 0) return null;
    return {
      nodes,
      relationships: edgeSpecs.map((spec) => {
        const [type, direction] = spec.split(':');
        return { type, direction: direction === 'in' ? 'in' : 'out' };
      }),
    };
  }

  // Builds `r.type IN ($..)` + optional repo scoping for a one-hop edge query.
  private edgeFilter(
    anchor: string,
    types: RelationshipType[],
    repoPath: string | undefined,
    base: unknown[]
  ): { where: string; params: unknown[] } {
    const placeholders = types.map((_, i) => `$${base.length + i + 1}`).join(', ');
    const params = [...base, ...types];
    let where = `${anchor} AND r.type IN (${placeholders})`;
    if (repoPath) {
      where += ` AND r.repo_path = $${params.length + 1}`;
      params.push(repoPath);
    }
    return { where, params };
  }

  // Shared fragments for the recursive walk queries. Returns the type filter,
  // accumulated params, a repo-clause helper, and the next free placeholder.
  private walkFilter(
    types: RelationshipType[],
    repoPath: string | undefined,
    base: unknown[]
  ): {
    typeList: string;
    params: unknown[];
    repoClause: (alias: string) => string;
    nextParam: number;
  } {
    const placeholders = types.map((_, i) => `$${base.length + i + 1}`).join(', ');
    const params = [...base, ...types];
    const nextParam = params.length + 1;
    return {
      typeList: `r.type IN (${placeholders})`,
      params,
      repoClause: (alias: string) => (repoPath ? ` AND ${alias}.repo_path = $${nextParam + 1}` : ''),
      nextParam,
    };
  }
}

const ENTITY_COLS = `
  e.id AS entity_id, e.stable_id AS entity_stable_id, e.repo_path AS entity_repo_path,
  e.name AS entity_name, e.type AS entity_type, e.language AS entity_language,
  e.file_path AS entity_file_path, e.start_line AS entity_start_line, e.end_line AS entity_end_line,
  e.start_column AS entity_start_column, e.end_column AS entity_end_column,
  e.signature AS entity_signature, e.docstring AS entity_docstring, e.purpose AS entity_purpose,
  e.responsibility AS entity_responsibility, e.domain AS entity_domain,
  e.architectural_role AS entity_architectural_role, e.is_exported AS entity_is_exported,
  e.is_test AS entity_is_test, e.confidence AS entity_confidence,
  e.first_seen_commit AS entity_first_seen_commit, e.last_seen_commit AS entity_last_seen_commit,
  e.created_at AS entity_created_at, e.updated_at AS entity_updated_at
`;

const REL_COLS = `
  r.id AS rel_id, r.source_id AS rel_source_id, r.target_id AS rel_target_id,
  r.type AS rel_type, r.file_path AS rel_file_path, r.line AS rel_line,
  r.confidence AS rel_confidence, r.metadata AS rel_metadata,
  r.created_at AS rel_created_at, r.updated_at AS rel_updated_at
`;

function mapRowToEntity(row: Record<string, any>): Entity {
  // Joined one-hop queries alias entity columns with an `entity_` prefix;
  // single-table queries use raw column names. Accept both.
  const v = (plain: string, prefixed: string): any =>
    row[prefixed] !== undefined ? row[prefixed] : row[plain];
  return {
    id: String(v('id', 'entity_id')),
    stableId: v('stable_id', 'entity_stable_id'),
    repoPath: v('repo_path', 'entity_repo_path'),
    name: v('name', 'entity_name'),
    type: v('type', 'entity_type') as EntityType,
    language: v('language', 'entity_language') as Language,
    filePath: v('file_path', 'entity_file_path'),
    startLine: v('start_line', 'entity_start_line'),
    endLine: v('end_line', 'entity_end_line'),
    startColumn: v('start_column', 'entity_start_column'),
    endColumn: v('end_column', 'entity_end_column'),
    signature: v('signature', 'entity_signature'),
    docstring: v('docstring', 'entity_docstring'),
    purpose: v('purpose', 'entity_purpose'),
    responsibility: v('responsibility', 'entity_responsibility'),
    domain: v('domain', 'entity_domain'),
    architecturalRole: v('architectural_role', 'entity_architectural_role'),
    isExported: v('is_exported', 'entity_is_exported'),
    isTest: v('is_test', 'entity_is_test'),
    confidence: v('confidence', 'entity_confidence'),
    firstSeenCommit: v('first_seen_commit', 'entity_first_seen_commit'),
    lastSeenCommit: v('last_seen_commit', 'entity_last_seen_commit'),
    createdAt: v('created_at', 'entity_created_at'),
    updatedAt: v('updated_at', 'entity_updated_at'),
  };
}

function mapRowToRelationship(row: Record<string, any>): Relationship {
  return {
    id: String(row.rel_id),
    sourceId: row.rel_source_id,
    targetId: row.rel_target_id,
    type: row.rel_type as RelationshipType,
    filePath: row.rel_file_path,
    line: row.rel_line,
    confidence: row.rel_confidence,
    metadata: row.rel_metadata,
    createdAt: row.rel_created_at,
    updatedAt: row.rel_updated_at,
  };
}
