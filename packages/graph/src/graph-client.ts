import neo4j, { Driver } from 'neo4j-driver';
import { Entity, Relationship, EntityType, RelationshipType, Language, getLogger } from '@repo-memory/shared';

const logger = getLogger({ component: 'graph' });

const MAX_TRAVERSAL_DEPTH = 6;

function clampDepth(maxDepth: number): number {
  if (!Number.isInteger(maxDepth) || maxDepth < 1) return 1;
  return Math.min(maxDepth, MAX_TRAVERSAL_DEPTH);
}

function isRelationshipType(type: string): type is RelationshipType {
  return (Object.values(RelationshipType) as string[]).includes(type);
}

function isEntityType(type: string): type is EntityType {
  return (Object.values(EntityType) as string[]).includes(type);
}

export class GraphClient {
  private driver: Driver;

  constructor(
    private uri: string = 'bolt://localhost:7687',
    private user: string = 'neo4j',
    private password: string = 'repo-memory-password'
  ) {
    this.driver = neo4j.driver(uri, neo4j.auth.basic(user, password));
  }

  async verifyConnectivity(): Promise<void> {
    try {
      await this.driver.verifyConnectivity();
      logger.info('Neo4j connection successful.');
    } catch (error) {
      logger.error({ err: error }, 'Neo4j connection failed');
      throw error;
    }
  }

  async createSchema(): Promise<void> {
    const session = this.driver.session();
    try {
      // Create indexes for entity types
      const entityTypes = Object.values(EntityType);
      for (const type of entityTypes) {
        if (!isEntityType(type)) continue;
        await session.run(`
          CREATE INDEX IF NOT EXISTS FOR (e:${type}) ON (e.stableId)
        `);
      }

      // Create indexes for relationship types
      const relationshipTypes = Object.values(RelationshipType);
      for (const type of relationshipTypes) {
        if (!isRelationshipType(type)) continue;
        await session.run(`
          CREATE INDEX IF NOT EXISTS FOR ()-[r:${type}]-() ON (r.filePath)
        `);
      }

      // Create uniqueness constraint for stableId
      await session.run(`
        CREATE CONSTRAINT IF NOT EXISTS FOR (e:Entity) REQUIRE e.stableId IS UNIQUE
      `);

      // Create fulltext index used by searchEntities
      await session.run(`
        CREATE FULLTEXT INDEX entitySearch IF NOT EXISTS
        FOR (e:Entity) ON EACH [e.name, e.purpose, e.responsibility]
      `);

      logger.debug('Neo4j schema created successfully.');
    } finally {
      await session.close();
    }
  }

  async upsertEntity(entity: Entity, repoPath: string = ''): Promise<void> {
    if (!isEntityType(entity.type)) {
      throw new Error(`Refusing to upsert entity with unknown type: ${entity.type}`);
    }
    const session = this.driver.session();
    try {
      const query = `
        MERGE (e:${entity.type} {stableId: $stableId})
        SET e.name = $name,
            e.type = $type,
            e.language = $language,
            e.repoPath = $repoPath,
            e.filePath = $filePath,
            e.startLine = $startLine,
            e.endLine = $endLine,
            e.startColumn = $startColumn,
            e.endColumn = $endColumn,
            e.signature = $signature,
            e.docstring = $docstring,
            e.purpose = $purpose,
            e.responsibility = $responsibility,
            e.domain = $domain,
            e.architecturalRole = $architecturalRole,
            e.isExported = $isExported,
            e.isTest = $isTest,
            e.confidence = $confidence,
            e.firstSeenCommit = $firstSeenCommit,
            e.lastSeenCommit = $lastSeenCommit,
            e.updatedAt = datetime()
        RETURN e
      `;

      await session.run(query, {
        stableId: entity.stableId,
        name: entity.name,
        type: entity.type,
        language: entity.language,
        repoPath: repoPath,
        filePath: entity.filePath,
        startLine: entity.startLine,
        endLine: entity.endLine,
        startColumn: entity.startColumn,
        endColumn: entity.endColumn,
        signature: entity.signature || null,
        docstring: entity.docstring || null,
        purpose: entity.purpose || null,
        responsibility: entity.responsibility || null,
        domain: entity.domain || null,
        architecturalRole: entity.architecturalRole || null,
        isExported: entity.isExported,
        isTest: entity.isTest,
        confidence: entity.confidence,
        firstSeenCommit: entity.firstSeenCommit || null,
        lastSeenCommit: entity.lastSeenCommit || null,
      });
    } finally {
      await session.close();
    }
  }

  async upsertRelationship(relationship: Relationship, repoPath: string = ''): Promise<void> {
    if (!isRelationshipType(relationship.type)) {
      throw new Error(`Refusing to upsert relationship with unknown type: ${relationship.type}`);
    }
    const session = this.driver.session();
    try {
      const query = `
        MATCH (source {stableId: $sourceId})
        MATCH (target {stableId: $targetId})
        MERGE (source)-[r:${relationship.type} {filePath: $filePath}]->(target)
        SET r.line = $line,
            r.confidence = $confidence,
            r.metadata = $metadata,
            r.repoPath = $repoPath,
            r.updatedAt = datetime()
        RETURN r
      `;

      await session.run(query, {
        sourceId: relationship.sourceId,
        targetId: relationship.targetId,
        filePath: relationship.filePath,
        line: relationship.line || null,
        confidence: relationship.confidence,
        metadata: JSON.stringify(relationship.metadata || {}),
        repoPath: repoPath || null,
      });
    } finally {
      await session.close();
    }
  }

  async findEntityByStableId(stableId: string): Promise<Entity | null> {
    const session = this.driver.session();
    try {
      const result = await session.run(
        'MATCH (e {stableId: $stableId}) RETURN e',
        { stableId }
      );
      
      if (result.records.length === 0) {
        return null;
      }
      
      return this.mapRecordToEntity(result.records[0].get('e'));
    } finally {
      await session.close();
    }
  }

  async findEntitiesByType(type: EntityType, limit: number = 100, repoPath?: string): Promise<Entity[]> {
    if (!isEntityType(type)) {
      throw new Error(`Refusing to query entities with unknown type: ${type}`);
    }
    const session = this.driver.session();
    try {
      const result = repoPath
        ? await session.run(
            `MATCH (e:${type}) WHERE e.repoPath = $repoPath RETURN e LIMIT $limit`,
            { repoPath, limit }
          )
        : await session.run(
            `MATCH (e:${type}) RETURN e LIMIT $limit`,
            { limit }
          );
      
      return result.records.map(record => this.mapRecordToEntity(record.get('e')));
    } finally {
      await session.close();
    }
  }

  async findEntitiesByFilePath(filePath: string, repoPath?: string): Promise<Entity[]> {
    const session = this.driver.session();
    try {
      const result = repoPath
        ? await session.run(
            'MATCH (e {filePath: $filePath, repoPath: $repoPath}) RETURN e',
            { filePath, repoPath }
          )
        : await session.run(
            'MATCH (e {filePath: $filePath}) RETURN e',
            { filePath }
          );
      
      return result.records.map(record => this.mapRecordToEntity(record.get('e')));
    } finally {
      await session.close();
    }
  }

  async findDependencies(stableId: string, repoPath?: string): Promise<{ entity: Entity; relationship: Relationship }[]> {
    const session = this.driver.session();
    try {
      const result = await session.run(
        `
        MATCH (source {stableId: $stableId})-[r:IMPORTS|DEPENDS_ON|CALLS|REFERENCES|HANDLES]->(target)
        WHERE ($repoPath IS NULL OR source.repoPath = $repoPath)
        RETURN target as entity, r as relationship,
               source.stableId AS sourceId, target.stableId AS targetId
        `,
        { stableId, repoPath: repoPath ?? null }
      );
      
      return result.records.map(record => ({
        entity: this.mapRecordToEntity(record.get('entity')),
        relationship: this.mapRecordToRelationship(record.get('relationship'), record.get('sourceId'), record.get('targetId')),
      }));
    } finally {
      await session.close();
    }
  }

  async findDependents(stableId: string, repoPath?: string): Promise<{ entity: Entity; relationship: Relationship }[]> {
    const session = this.driver.session();
    try {
      const result = await session.run(
        `
        MATCH (source)-[r:IMPORTS|DEPENDS_ON|CALLS|REFERENCES|HANDLES]->(target {stableId: $stableId})
        WHERE ($repoPath IS NULL OR source.repoPath = $repoPath)
        RETURN source as entity, r as relationship,
               source.stableId AS sourceId, target.stableId AS targetId
        `,
        { stableId, repoPath: repoPath ?? null }
      );
      
      return result.records.map(record => ({
        entity: this.mapRecordToEntity(record.get('entity')),
        relationship: this.mapRecordToRelationship(record.get('relationship'), record.get('sourceId'), record.get('targetId')),
      }));
    } finally {
      await session.close();
    }
  }

  async findTransitiveDependencies(stableId: string, maxDepth: number = 5, repoPath?: string): Promise<Entity[]> {
    const depth = clampDepth(maxDepth);
    const session = this.driver.session();
    try {
      const result = await session.run(
        `
        MATCH path = (source {stableId: $stableId})-[:IMPORTS|DEPENDS_ON|CALLS|REFERENCES|HANDLES*1..${depth}]->(target)
        WHERE ($repoPath IS NULL OR source.repoPath = $repoPath)
        RETURN DISTINCT target as entity
        `,
        { stableId, repoPath: repoPath ?? null }
      );
      
      return result.records.map(record => this.mapRecordToEntity(record.get('entity')));
    } finally {
      await session.close();
    }
  }

  async findTransitiveDependents(stableId: string, maxDepth: number = 5, repoPath?: string): Promise<Entity[]> {
    const depth = clampDepth(maxDepth);
    const session = this.driver.session();
    try {
      const result = await session.run(
        `
        MATCH path = (source)-[:IMPORTS|DEPENDS_ON|CALLS|REFERENCES|HANDLES*1..${depth}]->(target {stableId: $stableId})
        WHERE ($repoPath IS NULL OR source.repoPath = $repoPath)
        RETURN DISTINCT source as entity
        `,
        { stableId, repoPath: repoPath ?? null }
      );
      
      return result.records.map(record => this.mapRecordToEntity(record.get('entity')));
    } finally {
      await session.close();
    }
  }

  async findShortestPath(
    sourceId: string,
    targetId: string,
    maxDepth: number = 5
  ): Promise<{ nodes: Entity[]; relationships: Array<{ type: string; direction: 'out' | 'in' }> } | null> {
    const depth = clampDepth(maxDepth);
    const session = this.driver.session();
    try {
      const result = await session.run(
        `
        MATCH p = shortestPath((a {stableId: $sourceId})-[rels:IMPORTS|DEPENDS_ON|CALLS|REFERENCES|HANDLES|CONTAINS|EXPORTS*1..${depth}]-(b {stableId: $targetId}))
        RETURN p
        `,
        { sourceId, targetId }
      );
      if (result.records.length === 0) return null;

      const path = result.records[0].get('p');
      const nodes = [this.mapRecordToEntity(path.start), ...path.segments.map((s: any) => this.mapRecordToEntity(s.end))];
      const relationships: Array<{ type: string; direction: 'out' | 'in' }> = path.segments.map((s: any) => {
        const rel = s.relationship;
        const nodeId = (n: any) => ((n?.identity !== undefined ? n.identity : n) as any).toString();
        return {
          type: rel.type,
          direction: nodeId(rel.start) === nodeId(s.start) ? 'out' : 'in',
        };
      });
      return { nodes, relationships };
    } finally {
      await session.close();
    }
  }

  async searchEntities(query: string, limit: number = 50): Promise<Entity[]> {
    const session = this.driver.session();
    try {
      const result = await session.run(
        `
        CALL db.index.fulltext.queryNodes('entitySearch', $query)
        YIELD node, score
        RETURN node as entity
        LIMIT $limit
        `,
        { query, limit }
      );
      
      return result.records.map(record => this.mapRecordToEntity(record.get('entity')));
    } finally {
      await session.close();
    }
  }

  async deleteEntity(stableId: string): Promise<void> {
    const session = this.driver.session();
    try {
      await session.run(
        'MATCH (e {stableId: $stableId}) DETACH DELETE e',
        { stableId }
      );
    } finally {
      await session.close();
    }
  }

  async deleteRelationship(sourceId: string, targetId: string, type: string, filePath: string): Promise<void> {
    if (!isRelationshipType(type)) {
      throw new Error(`Refusing to delete relationship with unknown type: ${type}`);
    }
    const session = this.driver.session();
    try {
      await session.run(
        `MATCH (a {stableId: $sourceId})-[r:${type} {filePath: $filePath}]->(b {stableId: $targetId}) DELETE r`,
        { sourceId, targetId, filePath }
      );
    } finally {
      await session.close();
    }
  }

  async deleteEntitiesByFilePath(filePath: string, repoPath?: string): Promise<void> {
    const session = this.driver.session();
    try {
      if (repoPath) {
        await session.run(
          'MATCH (e {filePath: $filePath, repoPath: $repoPath}) DETACH DELETE e',
          { filePath, repoPath }
        );
      } else {
        await session.run(
          'MATCH (e {filePath: $filePath}) DETACH DELETE e',
          { filePath }
        );
      }
    } finally {
      await session.close();
    }
  }

  async deleteAll(repoPath: string): Promise<void> {
    const session = this.driver.session();
    try {
      await session.run(
        'MATCH (e) WHERE coalesce(e.repoPath, "") = $repoPath DETACH DELETE e',
        { repoPath }
      );
    } finally {
      await session.close();
    }
  }

  // --- Reconciliation (verify / repair) helpers ----------------------------

  async countEntities(repoPath: string): Promise<number> {
    const session = this.driver.session();
    try {
      const result = await session.run(
        'MATCH (e) WHERE e.repoPath = $repoPath RETURN count(e) AS count',
        { repoPath }
      );
      return result.records[0].get('count').toNumber();
    } finally {
      await session.close();
    }
  }

  async countEntitiesByType(repoPath: string): Promise<Array<{ type: string; count: number }>> {
    const session = this.driver.session();
    try {
      const result = await session.run(
        'MATCH (e) WHERE e.repoPath = $repoPath RETURN coalesce(e.type, "Unknown") AS type, count(e) AS count ORDER BY type',
        { repoPath }
      );
      return result.records.map((record) => ({
        type: record.get('type'),
        count: record.get('count').toNumber(),
      }));
    } finally {
      await session.close();
    }
  }

  async listEntityStableIds(repoPath: string): Promise<string[]> {
    const session = this.driver.session();
    try {
      const result = await session.run(
        'MATCH (e) WHERE e.repoPath = $repoPath RETURN e.stableId AS stableId',
        { repoPath }
      );
      return result.records.map((record) => record.get('stableId'));
    } finally {
      await session.close();
    }
  }

  async countRelationships(repoPath: string): Promise<number> {
    const session = this.driver.session();
    try {
      const result = await session.run(
        'MATCH (a {repoPath: $repoPath})-[r]->(b) RETURN count(r) AS count',
        { repoPath }
      );
      return result.records[0].get('count').toNumber();
    } finally {
      await session.close();
    }
  }

  async countRelationshipsByType(repoPath: string): Promise<Array<{ type: string; count: number }>> {
    const session = this.driver.session();
    try {
      const result = await session.run(
        'MATCH (a {repoPath: $repoPath})-[r]->(b) RETURN type(r) AS type, count(r) AS count ORDER BY type',
        { repoPath }
      );
      return result.records.map((record) => ({
        type: record.get('type'),
        count: record.get('count').toNumber(),
      }));
    } finally {
      await session.close();
    }
  }

  async listRelationshipKeys(repoPath: string): Promise<Array<{ sourceId: string; targetId: string; type: string; filePath: string }>> {
    const session = this.driver.session();
    try {
      const result = await session.run(
        'MATCH (a {repoPath: $repoPath})-[r]->(b) RETURN a.stableId AS sourceId, b.stableId AS targetId, type(r) AS type, r.filePath AS filePath',
        { repoPath }
      );
      return result.records.map((record) => ({
        sourceId: record.get('sourceId'),
        targetId: record.get('targetId'),
        type: record.get('type'),
        filePath: record.get('filePath'),
      }));
    } finally {
      await session.close();
    }
  }

  async close(): Promise<void> {
    await this.driver.close();
  }

  private mapRecordToEntity(node: any): Entity {
    const properties = node.properties;
    return {
      id: node.identity.toString(),
      stableId: properties.stableId,
      repoPath: properties.repoPath,
      name: properties.name,
      type: properties.type as EntityType,
      language: properties.language as Language,
      filePath: properties.filePath,
      startLine: properties.startLine,
      endLine: properties.endLine,
      startColumn: properties.startColumn,
      endColumn: properties.endColumn,
      signature: properties.signature,
      docstring: properties.docstring,
      purpose: properties.purpose,
      responsibility: properties.responsibility,
      domain: properties.domain,
      architecturalRole: properties.architecturalRole,
      isExported: properties.isExported,
      isTest: properties.isTest,
      confidence: properties.confidence,
      firstSeenCommit: properties.firstSeenCommit,
      lastSeenCommit: properties.lastSeenCommit,
      createdAt: properties.createdAt || new Date(),
      updatedAt: properties.updatedAt || new Date(),
    };
  }

  private mapRecordToRelationship(rel: any, sourceId: string, targetId: string): Relationship {
    const properties = rel.properties;
    return {
      id: rel.identity.toString(),
      sourceId,
      targetId,
      type: rel.type as RelationshipType,
      filePath: properties.filePath,
      line: properties.line,
      confidence: properties.confidence,
      metadata: properties.metadata ? JSON.parse(properties.metadata) : undefined,
      createdAt: properties.createdAt || new Date(),
      updatedAt: properties.updatedAt || new Date(),
    };
  }
}
