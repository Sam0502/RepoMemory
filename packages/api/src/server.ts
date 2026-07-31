import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { GraphClient } from '@repo-memory/graph';
import { EntityRepository, RelationshipRepository, CommitRepository } from '@repo-memory/storage';
import { Pool } from 'pg';
import { ContextPackBuilder } from './context-pack.js';

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
  const commitRepo = new CommitRepository(config.pgPool);
  const contextBuilder = new ContextPackBuilder(entityRepo, commitRepo, config.graphClient);

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

  // Similar entities endpoint (semantic search)
  app.get('/api/entities/similar/:stableId', async (c) => {
    const stableId = c.req.param('stableId');
    const limit = parseInt(c.req.query('limit') || '10');
    const entity = await entityRepo.findByStableId(stableId);
    if (!entity) {
      return c.json({ error: 'Entity not found' }, 404);
    }
    const similar = await entityRepo.findSimilar(stableId, limit);
    return c.json({ entity, similar });
  });

  // Commit endpoints
  app.get('/api/commits', async (c) => {
    const limit = parseInt(c.req.query('limit') || '20');
    const commits = await commitRepo.findRecent(limit);
    return c.json({ commits });
  });

  app.get('/api/commits/:hash', async (c) => {
    const hash = c.req.param('hash');
    const commit = await commitRepo.findByHash(hash);
    if (!commit) {
      return c.json({ error: 'Commit not found' }, 404);
    }
    const fileChanges = await commitRepo.getFileChanges(hash);
    return c.json({ commit, fileChanges });
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
    
    // Build a lookup map: normalized basename -> file paths (for resolving imports)
    const basenameToFiles = new Map<string, string[]>();
    for (const file of files) {
      const normalized = file.fullPath.replace(/\\/g, '/');
      // Index by full path for exact match
      if (!basenameToFiles.has(normalized)) {
        basenameToFiles.set(normalized, []);
      }
      basenameToFiles.get(normalized)!.push(file.id);
      
      // Also index by basename for fuzzy resolution
      const base = normalized.split('/').pop()!;
      if (!basenameToFiles.has(base)) {
        basenameToFiles.set(base, []);
      }
      basenameToFiles.get(base)!.push(file.id);
    }
    
    // Build package name -> index file mapping
    const packageNameToFiles = new Map<string, string[]>();
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
      
      // Skip external/builtin imports (no path separators, not relative)
      if (!target.startsWith('.') && !target.startsWith('@repo-memory/') && !target.includes('/')) {
        continue;
      }
      
      // Resolve @repo-memory/* package imports to index files
      if (target.startsWith('@repo-memory/')) {
        const targetFiles = packageNameToFiles.get(target) || [];
        const indexFile = targetFiles.find(f => f.includes('index.ts')) || targetFiles[0];
        if (indexFile) {
          target = indexFile;
        }
      }
      // Resolve relative imports (./foo, ../foo)
      else if (target.startsWith('.')) {
        const resolved = resolveRelativeImport(source, target, fileIds);
        if (resolved) {
          target = resolved;
        }
      }
      // Resolve bare module imports by basename matching
      else {
        const candidates = basenameToFiles.get(target.split('/').pop()!) || [];
        // Pick the first candidate that's in a similar directory depth
        if (candidates.length > 0) {
          target = candidates[0];
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

  // Context pack endpoint
  app.get('/api/context-pack/:stableId', async (c) => {
    const stableId = c.req.param('stableId');
    const tokenBudget = parseInt(c.req.query('tokenBudget') || '4000');
    const pack = await contextBuilder.build(stableId, tokenBudget);
    if (!pack) {
      return c.json({ error: 'Entity not found' }, 404);
    }
    return c.json(pack);
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

function resolveRelativeImport(sourceFile: string, importPath: string, fileIds: Set<string>): string | null {
  const normalizedSource = sourceFile.replace(/\\/g, '/');
  const sourceDir = normalizedSource.split('/').slice(0, -1).join('/');
  
  // Strip file extensions from import path for resolution
  const stripped = importPath.replace(/\.(ts|tsx|js|jsx|mjs|cjs)$/, '');
  
  // Resolve relative path
  const parts = (sourceDir + '/' + stripped).split('/');
  const resolved: string[] = [];
  for (const part of parts) {
    if (part === '..') {
      resolved.pop();
    } else if (part !== '.' && part !== '') {
      resolved.push(part);
    }
  }
  
  const base = resolved.join('/');
  
  // Try exact match first
  for (const ext of ['', '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '/index.ts', '/index.tsx', '/index.js', '/index.jsx']) {
    const candidate = base + ext;
    if (fileIds.has(candidate)) {
      return candidate;
    }
  }
  
  return null;
}

function getGroup(filePath: string): string {
  const normalizedPath = filePath.replace(/\\/g, '/');
  
  // RepoMemory internal packages
  if (normalizedPath.startsWith('app/')) return 'app';
  if (normalizedPath.startsWith('packages/shared/')) return 'shared';
  if (normalizedPath.startsWith('packages/ingestion/')) return 'ingestion';
  if (normalizedPath.startsWith('packages/analysis/')) return 'analysis';
  if (normalizedPath.startsWith('packages/graph/')) return 'graph';
  if (normalizedPath.startsWith('packages/storage/')) return 'storage';
  if (normalizedPath.startsWith('packages/api/')) return 'api';
  if (normalizedPath.startsWith('web/')) return 'web';
  
  // Generic groupings for external repos
  if (normalizedPath.includes('/test/') || normalizedPath.includes('/tests/') || normalizedPath.includes('/__tests__/') || normalizedPath.includes('.test.') || normalizedPath.includes('.spec.')) return 'tests';
  if (normalizedPath.includes('/src/')) return 'source';
  if (normalizedPath.includes('/lib/')) return 'lib';
  if (normalizedPath.includes('/cmd/')) return 'cmd';
  if (normalizedPath.includes('/internal/')) return 'internal';
  if (normalizedPath.includes('/pkg/')) return 'pkg';
  if (normalizedPath.includes('/config/') || normalizedPath.includes('/configs/')) return 'config';
  if (normalizedPath.includes('/docs/') || normalizedPath.includes('/doc/')) return 'docs';
  if (normalizedPath.includes('/scripts/')) return 'scripts';
  
  // Group by top-level directory
  const topLevel = normalizedPath.split('/')[0];
  if (topLevel) return topLevel;
  
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
