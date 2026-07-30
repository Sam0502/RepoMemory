import { Pool } from 'pg';
import { Entity, Relationship, EntityType, RelationshipType, Language } from '@repo-memory/shared';

export class EntityRepository {
  constructor(private pool: Pool) {}

  async create(entity: Omit<Entity, 'id' | 'createdAt' | 'updatedAt'>): Promise<Entity> {
    const query = `
      INSERT INTO entities (
        stable_id, name, type, language, file_path, start_line, end_line,
        start_column, end_column, signature, docstring, purpose, responsibility,
        domain, architectural_role, is_exported, is_test, confidence,
        first_seen_commit, last_seen_commit
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20)
      RETURNING *
    `;
    
    const values = [
      entity.stableId, entity.name, entity.type, entity.language,
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

  async upsert(entity: Omit<Entity, 'id' | 'createdAt' | 'updatedAt'>): Promise<Entity> {
    const query = `
      INSERT INTO entities (
        stable_id, name, type, language, file_path, start_line, end_line,
        start_column, end_column, signature, docstring, purpose, responsibility,
        domain, architectural_role, is_exported, is_test, confidence,
        first_seen_commit, last_seen_commit
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20)
      ON CONFLICT (stable_id) DO UPDATE SET
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
      entity.stableId, entity.name, entity.type, entity.language,
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

  async findById(id: string): Promise<Entity | null> {
    const query = 'SELECT * FROM entities WHERE id = $1';
    const result = await this.pool.query(query, [id]);
    return result.rows[0] ? this.mapRowToEntity(result.rows[0]) : null;
  }

  async findByStableId(stableId: string): Promise<Entity | null> {
    const query = 'SELECT * FROM entities WHERE stable_id = $1';
    const result = await this.pool.query(query, [stableId]);
    return result.rows[0] ? this.mapRowToEntity(result.rows[0]) : null;
  }

  async findByFilePath(filePath: string): Promise<Entity[]> {
    const query = 'SELECT * FROM entities WHERE file_path = $1 ORDER BY start_line';
    const result = await this.pool.query(query, [filePath]);
    return result.rows.map(this.mapRowToEntity);
  }

  async findByType(type: EntityType): Promise<Entity[]> {
    const query = 'SELECT * FROM entities WHERE type = $1 ORDER BY name';
    const result = await this.pool.query(query, [type]);
    return result.rows.map(this.mapRowToEntity);
  }

  async search(query: string): Promise<Entity[]> {
    const searchQuery = `
      SELECT * FROM entities 
      WHERE name ILIKE $1 OR purpose ILIKE $1 OR responsibility ILIKE $1
      ORDER BY name
      LIMIT 50
    `;
    const result = await this.pool.query(searchQuery, [`%${query}%`]);
    return result.rows.map(this.mapRowToEntity);
  }

  async findAll(limit: number = 100, offset: number = 0): Promise<Entity[]> {
    const query = 'SELECT * FROM entities ORDER BY name LIMIT $1 OFFSET $2';
    const result = await this.pool.query(query, [limit, offset]);
    return result.rows.map(this.mapRowToEntity);
  }

  async updateEmbedding(stableId: string, embedding: number[]): Promise<void> {
    const query = 'UPDATE entities SET embedding = $1 WHERE stable_id = $2';
    await this.pool.query(query, [JSON.stringify(embedding), stableId]);
  }

  async findSimilar(stableId: string, limit: number = 10, threshold: number = 0.5): Promise<Entity[]> {
    const query = `
      SELECT e.*, 1 - (e.embedding <=> (SELECT embedding FROM entities WHERE stable_id = $1)) AS similarity
      FROM entities e
      WHERE e.stable_id != $1
        AND e.embedding IS NOT NULL
        AND 1 - (e.embedding <=> (SELECT embedding FROM entities WHERE stable_id = $1)) > $3
      ORDER BY similarity DESC
      LIMIT $2
    `;
    const result = await this.pool.query(query, [stableId, limit, threshold]);
    return result.rows.map(this.mapRowToEntity);
  }

  async findByEmbedding(vector: number[], limit: number = 10, threshold: number = 0.5): Promise<Entity[]> {
    const query = `
      SELECT *, 1 - (embedding <=> $1::vector) AS similarity
      FROM entities
      WHERE embedding IS NOT NULL
        AND 1 - (embedding <=> $1::vector) > $3
      ORDER BY similarity DESC
      LIMIT $2
    `;
    const result = await this.pool.query(query, [JSON.stringify(vector), limit, threshold]);
    return result.rows.map(this.mapRowToEntity);
  }

  async count(): Promise<number> {
    const query = 'SELECT COUNT(*) as count FROM entities';
    const result = await this.pool.query(query);
    return parseInt(result.rows[0].count);
  }

  private mapRowToEntity(row: any): Entity {
    return {
      id: row.id,
      stableId: row.stable_id,
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
