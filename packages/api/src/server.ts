import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { GraphClient } from '@repo-memory/graph';
import { EntityRepository, RelationshipRepository } from '@repo-memory/storage';
import { Pool } from 'pg';

export interface ApiConfig {
  port: number;
  host: string;
  graphClient: GraphClient;
  pgPool: Pool;
}

export function createApp(config: ApiConfig, webDir?: string): Hono {
  const app = new Hono();
  const entityRepo = new EntityRepository(config.pgPool);
  const relationshipRepo = new RelationshipRepository(config.pgPool);

  // CORS for frontend
  app.use('*', async (c, next) => {
    c.header('Access-Control-Allow-Origin', '*');
    c.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    c.header('Access-Control-Allow-Headers', 'Content-Type');
    if (c.req.method === 'OPTIONS') {
      return new Response('', { status: 204 });
    }
    await next();
  });

  // Serve static files from web directory
  if (webDir) {
    app.use('/*', serveStatic({ root: webDir }));
  }

  // Health check
  app.get('/health', (c) => {
    return c.json({ status: 'ok', timestamp: new Date().toISOString() });
  });

  // Entity endpoints
  app.get('/api/entities', async (c) => {
    const limit = parseInt(c.req.query('limit') || '100');
    const offset = parseInt(c.req.query('offset') || '0');
    const entities = await entityRepo.findAll(limit, offset);
    const total = await entityRepo.count();
    return c.json({ entities, total, limit, offset });
  });

  app.get('/api/entities/:id', async (c) => {
    const id = c.req.param('id');
    const entity = await entityRepo.findById(id);
    if (!entity) {
      return c.json({ error: 'Entity not found' }, 404);
    }
    return c.json(entity);
  });

  app.get('/api/entities/search/:query', async (c) => {
    const query = c.req.param('query');
    const entities = await entityRepo.search(query);
    return c.json({ entities });
  });

  app.get('/api/entities/type/:type', async (c) => {
    const type = c.req.param('type');
    const entities = await entityRepo.findByType(type as any);
    return c.json({ entities });
  });

  app.get('/api/entities/file/:filePath', async (c) => {
    const filePath = c.req.param('filePath');
    const entities = await entityRepo.findByFilePath(filePath);
    return c.json({ entities });
  });

  // Relationship endpoints
  app.get('/api/relationships', async (c) => {
    const sourceId = c.req.query('sourceId');
    const targetId = c.req.query('targetId');
    const type = c.req.query('type');

    if (sourceId) {
      const relationships = await relationshipRepo.findBySourceId(sourceId);
      return c.json({ relationships });
    }

    if (targetId) {
      const relationships = await relationshipRepo.findByTargetId(targetId);
      return c.json({ relationships });
    }

    if (type) {
      const relationships = await relationshipRepo.findByType(type as any);
      return c.json({ relationships });
    }

    return c.json({ error: 'Provide sourceId, targetId, or type parameter' }, 400);
  });

  // Graph traversal endpoints
  app.get('/api/graph/traverse/:stableId', async (c) => {
    const stableId = c.req.param('stableId');
    const depth = parseInt(c.req.query('depth') || '1');

    const entity = await entityRepo.findByStableId(stableId);
    if (!entity) {
      return c.json({ error: 'Entity not found' }, 404);
    }

    // Get all entities in the same file (file-level dependencies)
    const sameFileEntities = await entityRepo.findByFilePath(entity.filePath);
    const dependencies = sameFileEntities
      .filter(e => e.stableId !== stableId)
      .slice(0, 20);

    // Get relationships involving this entity
    const relationships = await relationshipRepo.findByEntityId(stableId);
    
    // Find entities that this entity imports (by import path)
    const importRels = relationships.filter(r => r.type === 'IMPORTS' && r.sourceId === entity.filePath);
    const dependents = [];
    for (const rel of importRels) {
      // Try to find entities with matching names from import
      const importName = rel.targetId.split('/').pop() || rel.targetId;
      const matchingEntities = await entityRepo.search(importName);
      dependents.push(...matchingEntities.slice(0, 5));
    }

    return c.json({
      entity,
      dependencies,
      dependents: dependents.slice(0, 20),
      depth,
    });
  });

  app.get('/api/graph/dependencies/:stableId', async (c) => {
    const stableId = c.req.param('stableId');
    const dependencies = await graphClient.findDependencies(stableId);
    return c.json({ dependencies: dependencies.map(d => d.entity) });
  });

  app.get('/api/graph/dependents/:stableId', async (c) => {
    const stableId = c.req.param('stableId');
    const dependents = await graphClient.findDependents(stableId);
    return c.json({ dependents: dependents.map(d => d.entity) });
  });

  app.get('/api/graph/transitive/:stableId', async (c) => {
    const stableId = c.req.param('stableId');
    const maxDepth = parseInt(c.req.query('maxDepth') || '5');
    const entities = await graphClient.findTransitiveDependencies(stableId, maxDepth);
    return c.json({ entities });
  });

  // Architecture graph - file-level view
  app.get('/api/graph/architecture', async (c) => {
    // Get all unique files with entity counts
    const filesQuery = `
      SELECT file_path, COUNT(*) as entity_count,
             ARRAY_AGG(type) as entity_types
      FROM entities 
      GROUP BY file_path 
      ORDER BY file_path
    `;
    const filesResult = await config.pgPool.query(filesQuery);
    
    // Get import relationships
    const relsQuery = `
      SELECT DISTINCT source_id as source, target_id as target, type
      FROM relationships 
      WHERE type = 'IMPORTS'
    `;
    const relsResult = await config.pgPool.query(relsQuery);
    
    // Build file nodes
    const files = filesResult.rows.map(row => ({
      id: row.file_path,
      name: row.file_path.split(/[/\\]/).pop(),
      fullPath: row.file_path,
      entityCount: parseInt(row.entity_count),
      entityTypes: [...new Set(row.entity_types)],
      group: getGroup(row.file_path),
    }));
    
    // Build links - resolve import paths to file paths
    const fileIds = new Set(files.map(f => f.id));
    const packageNameToFiles = new Map<string, string[]>();
    
    // Index files by their package name
    for (const file of files) {
      const pkgMatch = file.fullPath.match(/packages\/([^/]+)\//);
      if (pkgMatch) {
        const pkgName = `@repo-memory/${pkgMatch[1]}`;
        if (!packageNameToFiles.has(pkgName)) {
          packageNameToFiles.set(pkgName, []);
        }
        packageNameToFiles.get(pkgName)!.push(file.id);
      }
    }
    
    const links = [];
    const seenLinks = new Set<string>();
    
    for (const row of relsResult.rows) {
      const source = row.source;
      let target = row.target;
      
      // Resolve package imports to actual files
      if (target.startsWith('@repo-memory/')) {
        const targetFiles = packageNameToFiles.get(target) || [];
        // Connect to the main index file or first file in package
        const indexFile = targetFiles.find(f => f.includes('index.ts')) || targetFiles[0];
        if (indexFile) {
          target = indexFile;
        }
      }
      
      // Only add links between existing files
      if (fileIds.has(source) && fileIds.has(target) && source !== target) {
        const linkKey = `${source}->${target}`;
        if (!seenLinks.has(linkKey)) {
          seenLinks.add(linkKey);
          links.push({ source, target, type: row.type });
        }
      }
    }
    
    return c.json({ files, links });
  });

  // Impact analysis
  app.get('/api/analysis/impact/:stableId', async (c) => {
    const stableId = c.req.param('stableId');
    
    const directImpact = await graphClient.findDependents(stableId);
    const indirectImpact = await graphClient.findTransitiveDependencies(stableId, 3);
    
    const affectedFiles = new Set<string>();
    directImpact.forEach(d => affectedFiles.add(d.entity.filePath));
    indirectImpact.forEach(e => affectedFiles.add(e.filePath));

    return c.json({
      directImpact: directImpact.map(d => d.entity),
      indirectImpact,
      affectedFiles: Array.from(affectedFiles),
      riskScore: Math.min(1.0, directImpact.length * 0.1 + indirectImpact.length * 0.05),
    });
  });

  return app;
}

function getGroup(filePath: string): string {
  const normalizedPath = filePath.replace(/\\/g, '/');
  if (normalizedPath.startsWith('app/')) return 'app';
  if (normalizedPath.startsWith('packages/shared/')) return 'shared';
  if (normalizedPath.startsWith('packages/ingestion/')) return 'ingestion';
  if (normalizedPath.startsWith('packages/analysis/')) return 'analysis';
  if (normalizedPath.startsWith('packages/graph/')) return 'graph';
  if (normalizedPath.startsWith('packages/storage/')) return 'storage';
  if (normalizedPath.startsWith('packages/api/')) return 'api';
  if (normalizedPath.startsWith('web/')) return 'web';
  return 'other';
}

let graphClient: GraphClient;

export function startServer(config: ApiConfig, webDir?: string): void {
  graphClient = config.graphClient;
  const app = createApp(config, webDir);

  serve({
    fetch: app.fetch,
    port: config.port,
    hostname: config.host,
  }, (info) => {
    console.log(`API server running at http://${config.host}:${info.port}`);
    if (webDir) {
      console.log(`Frontend available at http://${config.host}:${info.port}/`);
    }
  });
}
