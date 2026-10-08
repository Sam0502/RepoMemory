import { Pool, PoolClient } from 'pg';
import { Entity, EntityType, Language } from '@repo-memory/shared';

export class EntityRepository {
  constructor(private pool: Pool, private repoPath: string = '') {}

  async create(entity: Omit<Entity, 'id' | 'createdAt' | 'updatedAt'>): Promise<Entity> {
    const query = `
      INSERT INTO entities (
        repo_path, stable_id, name, type, language, file_path, start_line, end_line,
        start_column, end_column, signature, docstring, purpose, responsibility,
        domain, architectural_role, is_exported, is_test, confidence,
        first_seen_commit, last_seen_commit
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21)
      RETURNING *
    `;
    
    const values = [
      this.repoPath, entity.stableId, entity.name, entity.type, entity.language,
      entity.filePath, entity.startLine, entity.endLine,
      entity.startColumn, entity.endColumn, entity.signature,
      entity.docstring, entity.purpose, entity.responsibility,
      entity.domain, entity.architecturalRole, entity.isExported,
      entity.isTest, entity.confidence, entity.firstSeenCommit,
      entity.lastSeenCommit
    ];
    
    const result = await this.pool.query(query, values);
    return this.mapRowToEntity(result.rows[0]);
  }

  async upsert(entity: Omit<Entity, 'id' | 'createdAt' | 'updatedAt'>, client?: PoolClient): Promise<Entity> {
    const query = `
      INSERT INTO entities (
        repo_path, stable_id, name, type, language, file_path, start_line, end_line,
        start_column, end_column, signature, docstring, purpose, responsibility,
        domain, architectural_role, is_exported, is_test, confidence,
        first_seen_commit, last_seen_commit
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21)
      ON CONFLICT (repo_path, stable_id) DO UPDATE SET
        name = EXCLUDED.name,
        type = EXCLUDED.type,
        language = EXCLUDED.language,
        file_path = EXCLUDED.file_path,
        start_line = EXCLUDED.start_line,
        end_line = EXCLUDED.end_line,
        start_column = EXCLUDED.start_column,
        end_column = EXCLUDED.end_column,
        signature = EXCLUDED.signature,
        docstring = EXCLUDED.docstring,
        purpose = EXCLUDED.purpose,
        responsibility = EXCLUDED.responsibility,
        domain = EXCLUDED.domain,
        architectural_role = EXCLUDED.architectural_role,
        is_exported = EXCLUDED.is_exported,
        is_test = EXCLUDED.is_test,
        confidence = EXCLUDED.confidence,
        last_seen_commit = EXCLUDED.last_seen_commit,
        updated_at = NOW()
      RETURNING *
    `;
    
    const values = [
      this.repoPath, entity.stableId, entity.name, entity.type, entity.language,
      entity.filePath, entity.startLine, entity.endLine,
      entity.startColumn, entity.endColumn, entity.signature,
      entity.docstring, entity.purpose, entity.responsibility,
      entity.domain, entity.architecturalRole, entity.isExported,
      entity.isTest, entity.confidence, entity.firstSeenCommit,
      entity.lastSeenCommit
    ];
    
    const result = await (client ?? this.pool).query(query, values);
    return this.mapRowToEntity(result.rows[0]);
  }

  async findById(id: string): Promise<Entity | null> {
    const query = this.repoPath
      ? 'SELECT * FROM entities WHERE id = $1 AND repo_path = $2'
      : 'SELECT * FROM entities WHERE id = $1';
    const result = await this.pool.query(query, this.repoPath ? [id, this.repoPath] : [id]);
    return result.rows[0] ? this.mapRowToEntity(result.rows[0]) : null;
  }

  async findByStableId(stableId: string): Promise<Entity | null> {
    const query = this.repoPath
      ? 'SELECT * FROM entities WHERE stable_id = $1 AND repo_path = $2'
      : 'SELECT * FROM entities WHERE stable_id = $1';
    const result = await this.pool.query(query, this.repoPath ? [stableId, this.repoPath] : [stableId]);
    return result.rows[0] ? this.mapRowToEntity(result.rows[0]) : null;
  }

  async findByFilePath(filePath: string): Promise<Entity[]> {
    const query = this.repoPath
      ? 'SELECT * FROM entities WHERE file_path = $1 AND repo_path = $2 ORDER BY start_line'
      : 'SELECT * FROM entities WHERE file_path = $1 ORDER BY start_line';
    const result = await this.pool.query(query, this.repoPath ? [filePath, this.repoPath] : [filePath]);
    return result.rows.map(this.mapRowToEntity);
  }

  async findByType(type: EntityType, limit: number = 1000): Promise<Entity[]> {
    const query = this.repoPath
      ? 'SELECT * FROM entities WHERE type = $1 AND repo_path = $2 ORDER BY name LIMIT $3'
      : 'SELECT * FROM entities WHERE type = $1 ORDER BY name LIMIT $2';
    const result = await this.pool.query(query, this.repoPath ? [type, this.repoPath, limit] : [type, limit]);
    return result.rows.map(this.mapRowToEntity);
  }

  async search(query: string): Promise<Entity[]> {
    const searchQuery = this.repoPath
      ? `
        SELECT * FROM entities 
        WHERE (name ILIKE $1 OR purpose ILIKE $1 OR responsibility ILIKE $1)
          AND repo_path = $2
        ORDER BY name
        LIMIT 50
      `
      : `
        SELECT * FROM entities 
        WHERE name ILIKE $1 OR purpose ILIKE $1 OR responsibility ILIKE $1
        ORDER BY name
        LIMIT 50
      `;
    const result = await this.pool.query(searchQuery, this.repoPath ? [`%${query}%`, this.repoPath] : [`%${query}%`]);
    return result.rows.map(this.mapRowToEntity);
  }

  async findAll(limit: number = 100, offset: number = 0): Promise<Entity[]> {
    const query = this.repoPath
      ? 'SELECT * FROM entities WHERE repo_path = $1 ORDER BY name LIMIT $2 OFFSET $3'
      : 'SELECT * FROM entities ORDER BY name LIMIT $1 OFFSET $2';
    const result = await this.pool.query(query, this.repoPath ? [this.repoPath, limit, offset] : [limit, offset]);
    return result.rows.map(this.mapRowToEntity);
  }

  async updateEmbedding(stableId: string, embedding: number[], client?: PoolClient): Promise<void> {
    const query = this.repoPath
      ? 'UPDATE entities SET embedding = $1 WHERE stable_id = $2 AND repo_path = $3'
      : 'UPDATE entities SET embedding = $1 WHERE stable_id = $2';
    await (client ?? this.pool).query(query, this.repoPath ? [JSON.stringify(embedding), stableId, this.repoPath] : [JSON.stringify(embedding), stableId]);
  }

  async findSimilar(stableId: string, limit: number = 10, threshold: number = 0.5): Promise<Entity[]> {
    const query = this.repoPath
      ? `
        SELECT e.*, 1 - (e.embedding <=> (SELECT embedding FROM entities WHERE stable_id = $1 AND repo_path = $2)) AS similarity
        FROM entities e
        WHERE e.stable_id != $1
          AND e.repo_path = $2
          AND e.embedding IS NOT NULL
          AND 1 - (e.embedding <=> (SELECT embedding FROM entities WHERE stable_id = $1 AND repo_path = $2)) > $3
        ORDER BY similarity DESC
        LIMIT $4
      `
      : `
        SELECT e.*, 1 - (e.embedding <=> (SELECT embedding FROM entities WHERE stable_id = $1)) AS similarity
        FROM entities e
        WHERE e.stable_id != $1
          AND e.embedding IS NOT NULL
          AND 1 - (e.embedding <=> (SELECT embedding FROM entities WHERE stable_id = $1)) > $2
        ORDER BY similarity DESC
        LIMIT $3
      `;
    const result = await this.pool.query(query, this.repoPath ? [stableId, this.repoPath, threshold, limit] : [stableId, threshold, limit]);
    return result.rows.map(this.mapRowToEntity);
  }

  async findByEmbedding(vector: number[], limit: number = 10, threshold: number = 0.5): Promise<Entity[]> {
    const query = this.repoPath
      ? `
        SELECT *, 1 - (embedding <=> $1::vector) AS similarity
        FROM entities
        WHERE repo_path = $2
          AND embedding IS NOT NULL
          AND 1 - (embedding <=> $1::vector) > $3
        ORDER BY similarity DESC
        LIMIT $4
      `
      : `
        SELECT *, 1 - (embedding <=> $1::vector) AS similarity
        FROM entities
        WHERE embedding IS NOT NULL
          AND 1 - (embedding <=> $1::vector) > $2
        ORDER BY similarity DESC
        LIMIT $3
      `;
    const result = await this.pool.query(query, this.repoPath ? [JSON.stringify(vector), this.repoPath, threshold, limit] : [JSON.stringify(vector), threshold, limit]);
    return result.rows.map(this.mapRowToEntity);
  }

  async count(): Promise<number> {
    const query = this.repoPath
      ? 'SELECT COUNT(*) as count FROM entities WHERE repo_path = $1'
      : 'SELECT COUNT(*) as count FROM entities';
    const result = await this.pool.query(query, this.repoPath ? [this.repoPath] : []);
    return parseInt(result.rows[0].count);
  }

  async countByType(): Promise<Array<{ type: EntityType; count: number }>> {
    const query = this.repoPath
      ? 'SELECT type, COUNT(*) as count FROM entities WHERE repo_path = $1 GROUP BY type ORDER BY type'
      : 'SELECT type, COUNT(*) as count FROM entities GROUP BY type ORDER BY type';
    const result = await this.pool.query(query, this.repoPath ? [this.repoPath] : []);
    return result.rows.map((row) => ({ type: row.type as EntityType, count: parseInt(row.count) }));
  }

  async findAllStableIds(): Promise<string[]> {
    const query = this.repoPath
      ? 'SELECT stable_id FROM entities WHERE repo_path = $1'
      : 'SELECT stable_id FROM entities';
    const result = await this.pool.query(query, this.repoPath ? [this.repoPath] : []);
    return result.rows.map((row) => row.stable_id);
  }

  async findAllFilePaths(): Promise<string[]> {
    const query = this.repoPath
      ? 'SELECT DISTINCT file_path FROM entities WHERE repo_path = $1'
      : 'SELECT DISTINCT file_path FROM entities';
    const result = await this.pool.query(query, this.repoPath ? [this.repoPath] : []);
    return result.rows.map((row) => row.file_path);
  }

  async countWithoutEmbedding(): Promise<number> {
    const query = this.repoPath
      ? 'SELECT COUNT(*) as count FROM entities WHERE repo_path = $1 AND embedding IS NULL'
      : 'SELECT COUNT(*) as count FROM entities WHERE embedding IS NULL';
    const result = await this.pool.query(query, this.repoPath ? [this.repoPath] : []);
    return parseInt(result.rows[0].count);
  }

  async findWithoutEmbedding(limit: number = 1000, offset: number = 0): Promise<Entity[]> {
    const query = this.repoPath
      ? 'SELECT * FROM entities WHERE repo_path = $1 AND embedding IS NULL ORDER BY name LIMIT $2 OFFSET $3'
      : 'SELECT * FROM entities WHERE embedding IS NULL ORDER BY name LIMIT $1 OFFSET $2';
    const result = await this.pool.query(query, this.repoPath ? [this.repoPath, limit, offset] : [limit, offset]);
    return result.rows.map(this.mapRowToEntity);
  }

  async deleteByFilePath(filePath: string): Promise<void> {
    const query = this.repoPath
      ? 'DELETE FROM entities WHERE file_path = $1 AND repo_path = $2'
      : 'DELETE FROM entities WHERE file_path = $1';
    await this.pool.query(query, this.repoPath ? [filePath, this.repoPath] : [filePath]);
  }

  async deleteAll(client?: PoolClient): Promise<void> {
    const query = this.repoPath
      ? 'DELETE FROM entities WHERE repo_path = $1'
      : 'DELETE FROM entities';
    await (client ?? this.pool).query(query, this.repoPath ? [this.repoPath] : []);
  }

  private mapRowToEntity(row: any): Entity {
    return {
      id: row.id,
      stableId: row.stable_id,
      repoPath: row.repo_path,
      name: row.name,
      type: row.type as EntityType,
      language: row.language as Language,
      filePath: row.file_path,
      startLine: row.start_line,
      endLine: row.end_line,
      startColumn: row.start_column,
      endColumn: row.end_column,
      signature: row.signature,
      docstring: row.docstring,
      purpose: row.purpose,
      responsibility: row.responsibility,
      domain: row.domain,
      architecturalRole: row.architectural_role,
      isExported: row.is_exported,
      isTest: row.is_test,
      confidence: row.confidence,
      firstSeenCommit: row.first_seen_commit,
      lastSeenCommit: row.last_seen_commit,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }
}
