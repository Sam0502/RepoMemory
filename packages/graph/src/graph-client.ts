import neo4j, { Driver, Session } from 'neo4j-driver';
import { Entity, Relationship, EntityType, RelationshipType, Language } from '@repo-memory/shared';

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
      console.log('Neo4j connection successful.');
    } catch (error) {
      console.error('Neo4j connection failed:', error);
      throw error;
    }
  }

  async createSchema(): Promise<void> {
    const session = this.driver.session();
    try {
      // Create indexes for entity types
      const entityTypes = Object.values(EntityType);
      for (const type of entityTypes) {
        await session.run(`
          CREATE INDEX IF NOT EXISTS FOR (e:${type}) ON (e.stableId)
        `);
      }

      // Create indexes for relationship types
      const relationshipTypes = Object.values(RelationshipType);
      for (const type of relationshipTypes) {
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

      console.log('Neo4j schema created successfully.');
    } finally {
      await session.close();
    }
  }

  async upsertEntity(entity: Entity, repoPath: string = ''): Promise<void> {
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

  async upsertRelationship(relationship: Relationship): Promise<void> {
    const session = this.driver.session();
    try {
      const query = `
        MATCH (source {stableId: $sourceId})
        MATCH (target {stableId: $targetId})
        MERGE (source)-[r:${relationship.type} {filePath: $filePath}]->(target)
        SET r.line = $line,
            r.confidence = $confidence,
            r.metadata = $metadata,
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

  async findDependencies(stableId: string): Promise<{ entity: Entity; relationship: Relationship }[]> {
    const session = this.driver.session();
    try {
      const result = await session.run(
        `
        MATCH (source {stableId: $stableId})-[r:IMPORTS|DEPENDS_ON|CALLS|REFERENCES|HANDLES]->(target)
        RETURN target as entity, r as relationship
        `,
        { stableId }
      );
      
      return result.records.map(record => ({
        entity: this.mapRecordToEntity(record.get('entity')),
        relationship: this.mapRecordToRelationship(record.get('relationship')),
      }));
    } finally {
      await session.close();
    }
  }

  async findDependents(stableId: string): Promise<{ entity: Entity; relationship: Relationship }[]> {
    const session = this.driver.session();
    try {
      const result = await session.run(
        `
        MATCH (source)-[r:IMPORTS|DEPENDS_ON|CALLS|REFERENCES|HANDLES]->(target {stableId: $stableId})
        RETURN source as entity, r as relationship
        `,
        { stableId }
      );
      
      return result.records.map(record => ({
        entity: this.mapRecordToEntity(record.get('entity')),
        relationship: this.mapRecordToRelationship(record.get('relationship')),
      }));
    } finally {
      await session.close();
    }
  }

  async findTransitiveDependencies(stableId: string, maxDepth: number = 5): Promise<Entity[]> {
    const session = this.driver.session();
    try {
      const result = await session.run(
        `
        MATCH path = (source {stableId: $stableId})-[:IMPORTS|DEPENDS_ON|CALLS|REFERENCES|HANDLES*1..${maxDepth}]->(target)
        RETURN DISTINCT target as entity
        `,
        { stableId }
      );
      
      return result.records.map(record => this.mapRecordToEntity(record.get('entity')));
    } finally {
      await session.close();
    }
  }

  async findTransitiveDependents(stableId: string, maxDepth: number = 5): Promise<Entity[]> {
    const session = this.driver.session();
    try {
      const result = await session.run(
        `
        MATCH path = (source)-[:IMPORTS|DEPENDS_ON|CALLS|REFERENCES|HANDLES*1..${maxDepth}]->(target {stableId: $stableId})
        RETURN DISTINCT source as entity
        `,
        { stableId }
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
    const session = this.driver.session();
    try {
      const result = await session.run(
        `
        MATCH p = shortestPath((a {stableId: $sourceId})-[rels:IMPORTS|DEPENDS_ON|CALLS|REFERENCES|HANDLES|CONTAINS|EXPORTS*1..${maxDepth}]-(b {stableId: $targetId}))
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
        'MATCH (e) WHERE e.repoPath = $repoPath DETACH DELETE e',
        { repoPath }
      );
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

  private mapRecordToRelationship(rel: any): Relationship {
    const properties = rel.properties;
    return {
      id: rel.identity.toString(),
      sourceId: rel.start.toString(),
      targetId: rel.end.toString(),
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
