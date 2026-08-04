import { Pool, PoolClient } from 'pg';
import { Relationship, RelationshipType } from '@repo-memory/shared';

export class RelationshipRepository {
  constructor(private pool: Pool, private repoPath: string = '') {}

  async create(relationship: Omit<Relationship, 'id' | 'createdAt' | 'updatedAt'>): Promise<Relationship> {
    const query = `
      INSERT INTO relationships (repo_path, source_id, target_id, type, file_path, line, confidence, metadata)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
      RETURNING *
    `;
    
    const values = [
      this.repoPath, relationship.sourceId, relationship.targetId, relationship.type,
      relationship.filePath, relationship.line, relationship.confidence,
      JSON.stringify(relationship.metadata)
    ];
    
    const result = await this.pool.query(query, values);
    return this.mapRowToRelationship(result.rows[0]);
  }

  async upsert(relationship: Omit<Relationship, 'id' | 'createdAt' | 'updatedAt'>, client?: PoolClient): Promise<Relationship> {
    const query = `
      INSERT INTO relationships (repo_path, source_id, target_id, type, file_path, line, confidence, metadata)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
      ON CONFLICT (repo_path, source_id, target_id, type, file_path) DO UPDATE SET
        line = EXCLUDED.line,
        confidence = EXCLUDED.confidence,
        metadata = EXCLUDED.metadata,
        updated_at = NOW()
      RETURNING *
    `;
    
    const values = [
      this.repoPath, relationship.sourceId, relationship.targetId, relationship.type,
      relationship.filePath, relationship.line, relationship.confidence,
      JSON.stringify(relationship.metadata)
    ];
    
    const result = await (client ?? this.pool).query(query, values);
    return this.mapRowToRelationship(result.rows[0]);
  }

  async findById(id: string): Promise<Relationship | null> {
    const query = this.repoPath
      ? 'SELECT * FROM relationships WHERE id = $1 AND repo_path = $2'
      : 'SELECT * FROM relationships WHERE id = $1';
    const result = await this.pool.query(query, this.repoPath ? [id, this.repoPath] : [id]);
    return result.rows[0] ? this.mapRowToRelationship(result.rows[0]) : null;
  }

  async findBySourceId(sourceId: string): Promise<Relationship[]> {
    const query = this.repoPath
      ? 'SELECT * FROM relationships WHERE source_id = $1 AND repo_path = $2 ORDER BY type'
      : 'SELECT * FROM relationships WHERE source_id = $1 ORDER BY type';
    const result = await this.pool.query(query, this.repoPath ? [sourceId, this.repoPath] : [sourceId]);
    return result.rows.map(this.mapRowToRelationship);
  }

  async findByTargetId(targetId: string): Promise<Relationship[]> {
    const query = this.repoPath
      ? 'SELECT * FROM relationships WHERE target_id = $1 AND repo_path = $2 ORDER BY type'
      : 'SELECT * FROM relationships WHERE target_id = $1 ORDER BY type';
    const result = await this.pool.query(query, this.repoPath ? [targetId, this.repoPath] : [targetId]);
    return result.rows.map(this.mapRowToRelationship);
  }

  async findByEntityId(entityId: string): Promise<Relationship[]> {
    const query = this.repoPath
      ? 'SELECT * FROM relationships WHERE (source_id = $1 OR target_id = $1) AND repo_path = $2 ORDER BY type'
      : 'SELECT * FROM relationships WHERE source_id = $1 OR target_id = $1 ORDER BY type';
    const result = await this.pool.query(query, this.repoPath ? [entityId, this.repoPath] : [entityId]);
    return result.rows.map(this.mapRowToRelationship);
  }

  async findByType(type: RelationshipType): Promise<Relationship[]> {
    const query = this.repoPath
      ? 'SELECT * FROM relationships WHERE type = $1 AND repo_path = $2 ORDER BY created_at'
      : 'SELECT * FROM relationships WHERE type = $1 ORDER BY created_at';
    const result = await this.pool.query(query, this.repoPath ? [type, this.repoPath] : [type]);
    return result.rows.map(this.mapRowToRelationship);
  }

  // Paged window over a set of relationship types, ordered by the stable
  // (source_id, id) key so pagination is deterministic across calls. Used by
  // the streaming analysis paths so only one window is in memory at a time.
  async findByTypesPaged(types: RelationshipType[], limit: number = 100, offset: number = 0): Promise<Relationship[]> {
    if (types.length === 0) return [];
    const placeholders = types.map((_, i) => `$${i + 1}`).join(', ');
    const values: unknown[] = [...types];
    let query = `SELECT * FROM relationships WHERE type IN (${placeholders})`;
    if (this.repoPath) {
      values.push(this.repoPath);
      query += ` AND repo_path = $${values.length}`;
    }
    values.push(limit, offset);
    query += ` ORDER BY source_id, id LIMIT $${values.length - 1} OFFSET $${values.length}`;
    const result = await this.pool.query(query, values);
    return result.rows.map(this.mapRowToRelationship);
  }

  async findByFilePath(filePath: string): Promise<Relationship[]> {
    const query = this.repoPath
      ? 'SELECT * FROM relationships WHERE file_path = $1 AND repo_path = $2 ORDER BY type'
      : 'SELECT * FROM relationships WHERE file_path = $1 ORDER BY type';
    const result = await this.pool.query(query, this.repoPath ? [filePath, this.repoPath] : [filePath]);
    return result.rows.map(this.mapRowToRelationship);
  }

  async findDependencies(entityId: string): Promise<Relationship[]> {
    const query = this.repoPath
      ? `
        SELECT * FROM relationships 
        WHERE source_id = $1 AND repo_path = $2 AND type IN ('IMPORTS', 'DEPENDS_ON', 'CALLS', 'REFERENCES')
        ORDER BY type
      `
      : `
        SELECT * FROM relationships 
        WHERE source_id = $1 AND type IN ('IMPORTS', 'DEPENDS_ON', 'CALLS', 'REFERENCES')
        ORDER BY type
      `;
    const result = await this.pool.query(query, this.repoPath ? [entityId, this.repoPath] : [entityId]);
    return result.rows.map(this.mapRowToRelationship);
  }

  async findDependents(entityId: string): Promise<Relationship[]> {
    const query = this.repoPath
      ? `
        SELECT * FROM relationships 
        WHERE target_id = $1 AND repo_path = $2 AND type IN ('IMPORTS', 'DEPENDS_ON', 'CALLS', 'REFERENCES')
        ORDER BY type
      `
      : `
        SELECT * FROM relationships 
        WHERE target_id = $1 AND type IN ('IMPORTS', 'DEPENDS_ON', 'CALLS', 'REFERENCES')
        ORDER BY type
      `;
    const result = await this.pool.query(query, this.repoPath ? [entityId, this.repoPath] : [entityId]);
    return result.rows.map(this.mapRowToRelationship);
  }

  async deleteByFilePath(filePath: string): Promise<void> {
    const query = this.repoPath
      ? 'DELETE FROM relationships WHERE file_path = $1 AND repo_path = $2'
      : 'DELETE FROM relationships WHERE file_path = $1';
    await this.pool.query(query, this.repoPath ? [filePath, this.repoPath] : [filePath]);
  }

  async deleteAll(client?: PoolClient): Promise<void> {
    const query = this.repoPath
      ? 'DELETE FROM relationships WHERE repo_path = $1'
      : 'DELETE FROM relationships';
    await (client ?? this.pool).query(query, this.repoPath ? [this.repoPath] : []);
  }

  async count(): Promise<number> {
    const query = this.repoPath
      ? 'SELECT COUNT(*) as count FROM relationships WHERE repo_path = $1'
      : 'SELECT COUNT(*) as count FROM relationships';
    const result = await this.pool.query(query, this.repoPath ? [this.repoPath] : []);
    return parseInt(result.rows[0].count);
  }

  async countByType(): Promise<Array<{ type: RelationshipType; count: number }>> {
    const query = this.repoPath
      ? 'SELECT type, COUNT(*) as count FROM relationships WHERE repo_path = $1 GROUP BY type ORDER BY type'
      : 'SELECT type, COUNT(*) as count FROM relationships GROUP BY type ORDER BY type';
    const result = await this.pool.query(query, this.repoPath ? [this.repoPath] : []);
    return result.rows.map((row) => ({ type: row.type as RelationshipType, count: parseInt(row.count) }));
  }

  // Reconciliation keys: the tuple that uniquely identifies a relationship in
  // both stores (matching the repo-scoped unique constraint).
  async findAllKeys(): Promise<Array<{ sourceId: string; targetId: string; type: RelationshipType; filePath: string }>> {
    const query = this.repoPath
      ? 'SELECT source_id, target_id, type, file_path FROM relationships WHERE repo_path = $1'
      : 'SELECT source_id, target_id, type, file_path FROM relationships';
    const result = await this.pool.query(query, this.repoPath ? [this.repoPath] : []);
    return result.rows.map((row) => ({
      sourceId: row.source_id,
      targetId: row.target_id,
      type: row.type as RelationshipType,
      filePath: row.file_path,
    }));
  }

  async findAll(limit: number = 100, offset: number = 0): Promise<Relationship[]> {
    const query = this.repoPath
      ? 'SELECT * FROM relationships WHERE repo_path = $1 ORDER BY source_id LIMIT $2 OFFSET $3'
      : 'SELECT * FROM relationships ORDER BY source_id LIMIT $1 OFFSET $2';
    const result = await this.pool.query(query, this.repoPath ? [this.repoPath, limit, offset] : [limit, offset]);
    return result.rows.map(this.mapRowToRelationship);
  }

  private mapRowToRelationship(row: any): Relationship {
    return {
      id: row.id,
      sourceId: row.source_id,
      targetId: row.target_id,
      type: row.type as RelationshipType,
      filePath: row.file_path,
      line: row.line,
      confidence: row.confidence,
      metadata: row.metadata,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }
}
