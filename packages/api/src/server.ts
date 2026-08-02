import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { GraphClient } from '@repo-memory/graph';
import { EntityRepository, RelationshipRepository, CommitRepository, JobRepository } from '@repo-memory/storage';
import { parseDomainConfig, ChangeAnalyzer, streamDeadCode, streamBoundaries, resolveBatchSize } from '@repo-memory/analysis';
import type { DomainConfig } from '@repo-memory/analysis';
import { Entity, Relationship, RelationshipType, JobType, getLogger, metrics, registerDefaultMetrics } from '@repo-memory/shared';
import type { Logger, Job, RepoStatus } from '@repo-memory/shared';
import { Pool } from 'pg';
import { readFileSync } from 'fs';
import { join } from 'path';
import { randomUUID } from 'crypto';
import { ContextPackBuilder } from './context-pack.js';
import { QaService } from './qa.js';

export interface ApiConfig {
  port: number;
  host: string;
  repoPath: string;
  graphClient: GraphClient;
  pgPool: Pool;
  logger?: Logger;
  // Optional job runner (wired from the CLI's initialized orchestrator). When
  // absent, the POST job endpoints respond 501 but job history stays readable.
  runJob?: (type: JobType, repoPath?: string) => Promise<Job>;
  // Optional live-status provider (wired from the CLI's `watch` mode). When
  // absent, `GET /api/status` reports the repo as not being watched.
  getStatus?: () => Promise<RepoStatus>;
}

export function createApp(config: ApiConfig, webDir?: string): Hono {
  const app = new Hono();
  const log = config.logger || getLogger({ component: 'api', repoPath: config.repoPath });
  registerDefaultMetrics();
  const entityRepo = new EntityRepository(config.pgPool, config.repoPath);
  const relationshipRepo = new RelationshipRepository(config.pgPool, config.repoPath);
  const commitRepo = new CommitRepository(config.pgPool, config.repoPath);
  const jobRepo = new JobRepository(config.pgPool);
  const qaService = new QaService(entityRepo, relationshipRepo, commitRepo, config.graphClient, config.pgPool, false, config.repoPath);

  // Unfiltered repositories for workspace-wide (cross-repo) queries.
  // Entity stable IDs are namespaced by repo path, so cross-repo lookups are safe.
  const workspaceEntityRepo = new EntityRepository(config.pgPool, '');
  const workspaceRelationshipRepo = new RelationshipRepository(config.pgPool, '');
  const workspaceCommitRepo = new CommitRepository(config.pgPool, '');
  const workspaceContextBuilder = new ContextPackBuilder(workspaceEntityRepo, workspaceCommitRepo, config.graphClient);
  const workspaceQa = new QaService(workspaceEntityRepo, workspaceRelationshipRepo, workspaceCommitRepo, config.graphClient, config.pgPool, true, '');

  // Resolve a repo filter value ("all" / empty = every repo) to a scoped repo instance.
  const repoFor = (repoPath: string | undefined): EntityRepository =>
    repoPath && repoPath !== 'all' ? new EntityRepository(config.pgPool, repoPath) : workspaceEntityRepo;

  // --- Change analysis (churn / risk / drift) ------------------------------
  // Paged access so the streaming analysis paths keep only one window of each
  // store in memory regardless of repo size.
  const changeAnalyzerFor = (_repoPath: string): ChangeAnalyzer =>
    new ChangeAnalyzer({
      fileChurnRows: (p, days) => new CommitRepository(config.pgPool, p).getFileChurn(p, 100000, days),
      entityPage: (p, offset, limit) => new EntityRepository(config.pgPool, p).findAll(limit, offset),
      relationshipPage: (p, offset, limit) =>
        new RelationshipRepository(config.pgPool, p).findByTypesPaged(
          [
            RelationshipType.CALLS,
            RelationshipType.REFERENCES,
            RelationshipType.IMPORTS,
            RelationshipType.EXTENDS,
            RelationshipType.IMPLEMENTS,
            RelationshipType.HANDLES,
          ],
          limit,
          offset
        ),
      entityByStableId: (p, stableId) => new EntityRepository(config.pgPool, p).findByStableId(stableId),
      entities: async (repoPath) => {
        const repo = new EntityRepository(config.pgPool, repoPath);
        const entities: Entity[] = [];
        const limit = resolveBatchSize();
        let offset = 0;
        while (true) {
          const batch = await repo.findAll(limit, offset);
          entities.push(...batch);
          if (batch.length < limit) break;
          offset += limit;
        }
        return entities;
      },
      relationships: async (repoPath) => {
        const repo = new RelationshipRepository(config.pgPool, repoPath);
        const rels: Relationship[] = [];
        const limit = resolveBatchSize();
        let offset = 0;
        while (true) {
          const batch = await repo.findByTypesPaged(
            [
              RelationshipType.CALLS,
              RelationshipType.REFERENCES,
              RelationshipType.IMPORTS,
              RelationshipType.EXTENDS,
              RelationshipType.IMPLEMENTS,
              RelationshipType.HANDLES,
            ],
            limit,
            offset
          );
          rels.push(...batch);
          if (batch.length < limit) break;
          offset += limit;
        }
        return rels;
      },
      lastCommitDate: (p) => new CommitRepository(config.pgPool, p).getLastCommitDate(p),
    });

  const changeAnalyzer = changeAnalyzerFor(config.repoPath);

  // Request logging + metrics: capture method/path/status/duration and correlate
  // logs via X-Request-Id. Runs first so it also measures CORS + static serving.
  const isApiRequest = (path: string): boolean =>
    path.startsWith('/api/') || path === '/health' || path === '/metrics';

  app.use('*', async (c, next) => {
    const requestId = c.req.header('x-request-id') || randomUUID();
    c.header('X-Request-Id', requestId);

    const start = performance.now();
    await next();
    const durationMs = performance.now() - start;
    const status = c.res.status || 404;

    metrics.inc('repo_memory_api_requests_total', {
      method: c.req.method,
      path: c.req.path,
      status: String(status),
    });
    metrics.observe('repo_memory_api_request_duration_seconds', durationMs / 1000);

    const fields = { requestId, method: c.req.method, path: c.req.path, status, durationMs };
    if (isApiRequest(c.req.path)) {
      log.info(fields, 'request completed');
    } else {
      log.debug(fields, 'request completed');
    }
  });

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

  // Live status (watch mode): watched repo + last scan time for the "live" indicator
  app.get('/api/status', async (c) => {
    const status = config.getStatus
      ? await config.getStatus()
      : { repoPath: config.repoPath, watching: false, lastScanAt: null, pendingChanges: 0 };
    return c.json(status);
  });

  // Prometheus metrics (disable with METRICS_ENABLED=false)
  if ((process.env.METRICS_ENABLED ?? 'true') !== 'false') {
    app.get('/metrics', (c) => {
      registerDefaultMetrics();
      return c.text(metrics.render(), 200, {
        'Content-Type': 'text/plain; version=0.0.4; charset=utf-8',
      });
    });
  }

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

    const entity = await workspaceEntityRepo.findByStableId(stableId);
    if (!entity) {
      return c.json({ error: 'Entity not found' }, 404);
    }

    // Get all entities in the same file (file-level dependencies)
    const sameFileEntities = await workspaceEntityRepo.findByFilePath(entity.filePath);
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
      const matchingEntities = await workspaceEntityRepo.search(importName);
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
    const entity = await workspaceEntityRepo.findByStableId(stableId);
    if (!entity) {
      return c.json({ error: 'Entity not found' }, 404);
    }
    const similar = await workspaceEntityRepo.findSimilar(stableId, limit);
    return c.json({ entity, similar });
  });

  // Commit endpoints
  app.get('/api/commits', async (c) => {
    const limit = parseInt(c.req.query('limit') || '20');
    const repoPath = c.req.query('repoPath');
    const commits = repoPath && repoPath !== 'all'
      ? await new CommitRepository(config.pgPool, repoPath).findRecent(limit)
      : await workspaceCommitRepo.findRecent(limit);
    return c.json({ commits });
  });

  app.get('/api/commits/:hash', async (c) => {
    const hash = c.req.param('hash');
    const commit = await workspaceCommitRepo.findByHash(hash);
    if (!commit) {
      return c.json({ error: 'Commit not found' }, 404);
    }
    const fileChanges = await workspaceCommitRepo.getFileChanges(hash);
    return c.json({ commit, fileChanges });
  });

  // Architecture graph - file-level view
  app.get('/api/graph/architecture', async (c) => {
    const repoFilter = c.req.query('repoPath') || config.repoPath;
    const isAll = repoFilter === 'all' || repoFilter === '';

    // Get all unique files with entity counts
    const filesQuery = isAll
      ? `SELECT file_path, COUNT(*) as entity_count,
                ARRAY_AGG(type) as entity_types
         FROM entities 
         GROUP BY file_path 
         ORDER BY file_path`
      : `SELECT file_path, COUNT(*) as entity_count,
                ARRAY_AGG(type) as entity_types
         FROM entities 
         WHERE repo_path = $1
         GROUP BY file_path 
         ORDER BY file_path`;
    const filesResult = await config.pgPool.query(filesQuery, isAll ? [] : [repoFilter]);

    // Get import relationships
    const relsQuery = isAll
      ? `SELECT DISTINCT source_id as source, target_id as target, type
         FROM relationships 
         WHERE type = 'IMPORTS'`
      : `SELECT DISTINCT source_id as source, target_id as target, type
         FROM relationships 
         WHERE type = 'IMPORTS' AND repo_path = $1`;
    const relsResult = await config.pgPool.query(relsQuery, isAll ? [] : [repoFilter]);
    
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
    const pack = await workspaceContextBuilder.build(stableId, tokenBudget);
    if (!pack) {
      return c.json({ error: 'Entity not found' }, 404);
    }
    return c.json(pack);
  });

  // Impact analysis
  app.get('/api/analysis/impact/:stableId', async (c) => {
    const stableId = c.req.param('stableId');
    
    const directImpact = await graphClient.findDependents(stableId);
    const indirectImpact = await graphClient.findTransitiveDependents(stableId, 3);
    
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

  // Dead code detection (streamed in windows; ?batchSize= tunes page size)
  app.get('/api/analysis/dead-code', async (c) => {
    const includeExported = c.req.query('includeExported') === 'true';
    const batchSize = parseInt(c.req.query('batchSize') || String(resolveBatchSize()));

    const report = await streamDeadCode(
      { page: (offset, limit) => entityRepo.findAll(limit, offset) },
      {
        page: (offset, limit) =>
          relationshipRepo.findByTypesPaged(
            [RelationshipType.CALLS, RelationshipType.REFERENCES, RelationshipType.IMPORTS, RelationshipType.EXTENDS, RelationshipType.IMPLEMENTS],
            limit,
            offset
          ),
      },
      { batchSize }
    );
    return c.json(includeExported ? report : { ...report, exportedButUnused: [] });
  });

  // Ownership analysis (dominant author per file from commit history)
  app.get('/api/analysis/ownership', async (c) => {
    const limit = parseInt(c.req.query('limit') || '500');
    const result = await config.pgPool.query(
      `SELECT file_path,
              (ARRAY_AGG(author ORDER BY cnt DESC))[1] AS owner,
              MAX(cnt) AS commits
       FROM (
         SELECT f.file_path, c.author, COUNT(*) AS cnt
         FROM file_changes f
         JOIN commits c ON c.hash = f.commit_hash
         WHERE c.repo_path = $1
         GROUP BY f.file_path, c.author
       ) sub
       GROUP BY file_path
       ORDER BY file_path
       LIMIT $2`,
      [config.repoPath, limit]
    );
    return c.json({
      ownership: result.rows.map(row => ({
        filePath: row.file_path,
        owner: row.owner,
        commits: parseInt(row.commits),
      })),
    });
  });

  // Architecture boundary validation (streamed in windows; ?batchSize= tunes page size)
  app.get('/api/analysis/boundaries', async (c) => {
    const batchSize = parseInt(c.req.query('batchSize') || String(resolveBatchSize()));

    let domainConfig: DomainConfig | undefined;
    try {
      const content = readFileSync(join(config.repoPath, '.repomemory', 'boundaries.json'), 'utf-8');
      domainConfig = parseDomainConfig(content);
    } catch {
      domainConfig = undefined;
    }

    const report = await streamBoundaries(
      { page: (offset, limit) => entityRepo.findAll(limit, offset) },
      {
        page: (offset, limit) =>
          relationshipRepo.findByTypesPaged(
            [RelationshipType.IMPORTS, RelationshipType.CALLS, RelationshipType.REFERENCES, RelationshipType.EXTENDS, RelationshipType.IMPLEMENTS],
            limit,
            offset
          ),
      },
      domainConfig,
      { batchSize }
    );
    return c.json(report);
  });

  // Change analysis: churn / risk / drift
  app.get('/api/analysis/churn', async (c) => {
    const limit = parseInt(c.req.query('limit') || '50');
    const days = c.req.query('days') ? parseInt(c.req.query('days')!) : undefined;
    const churn = await changeAnalyzer.computeFileChurn(config.repoPath, limit, days);
    return c.json({ churn });
  });

  app.get('/api/analysis/risk', async (c) => {
    const risk = await changeAnalyzer.computeFileRisk(config.repoPath);
    return c.json({ risk });
  });

  app.get('/api/analysis/risk/:stableId', async (c) => {
    const stableId = c.req.param('stableId');
    const entity = await workspaceEntityRepo.findByStableId(stableId);
    if (!entity) {
      return c.json({ error: 'Entity not found' }, 404);
    }
    const info = await changeAnalyzerFor(entity.repoPath || config.repoPath).computeEntityChange(entity.repoPath || config.repoPath, stableId);
    return c.json({ entity: info });
  });

  app.get('/api/analysis/drift', async (c) => {
    const report = await changeAnalyzer.detectDrift(config.repoPath);
    return c.json(report);
  });

  // Question-answering for agents: classified intents over the stored graph
  app.post('/api/qa/ask', async (c) => {
    const body: { question?: string } = await c.req.json().catch(() => ({}));
    const question = (body.question || '').trim();
    if (!question) {
      return c.json({ error: 'question is required' }, 400);
    }
    const answer = await qaService.ask(question);
    return c.json(answer);
  });

  // --- Reconciliation & repair jobs (5.4) -----------------------------------

  app.get('/api/jobs', async (c) => {
    const limit = parseInt(c.req.query('limit') || '50');
    const type = c.req.query('type');
    const jobs = type
      ? await jobRepo.findByType(type as any, limit)
      : await jobRepo.findAll(limit);
    return c.json({ jobs });
  });

  app.get('/api/jobs/:id', async (c) => {
    const job = await jobRepo.findById(c.req.param('id'));
    if (!job) {
      return c.json({ error: 'Job not found' }, 404);
    }
    return c.json(job);
  });

  // POST job endpoints run synchronously and return the completed job (its
  // `result` carries the VerificationReport / RepairReport). Requires a wired
  // `runJob` callback (the CLI's `serve` command provides one).
  app.post('/api/jobs/verify', async (c) => {
    if (!config.runJob) {
      return c.json({ error: 'Job runner not available' }, 501);
    }
    const body: { repoPath?: string } = await c.req.json().catch(() => ({}));
    const job = await config.runJob(JobType.VERIFY, body.repoPath || config.repoPath);
    return c.json(job);
  });

  app.post('/api/jobs/repair', async (c) => {
    if (!config.runJob) {
      return c.json({ error: 'Job runner not available' }, 501);
    }
    const body: { repoPath?: string } = await c.req.json().catch(() => ({}));
    const job = await config.runJob(JobType.REPAIR, body.repoPath || config.repoPath);
    return c.json(job);
  });

  // --- Workspace (cross-repo) endpoints -------------------------------------

  app.get('/api/workspace/repos', async (c) => {
    const result = await config.pgPool.query(
      `SELECT e.repo_path AS repo_path,
              COUNT(e.id)::int AS entity_count,
              (SELECT COUNT(*)::int FROM commits c WHERE c.repo_path = e.repo_path) AS commit_count
       FROM entities e
       WHERE e.repo_path <> ''
       GROUP BY e.repo_path
       ORDER BY e.repo_path`
    );
    const state = await config.pgPool.query(
      'SELECT repo_path, last_commit_hash, last_scan_at FROM repo_state'
    );
    const stateByPath = new Map(state.rows.map(r => [r.repo_path, r]));
    return c.json({
      repos: result.rows.map(row => ({
        repoPath: row.repo_path,
        entityCount: parseInt(row.entity_count),
        commitCount: parseInt(row.commit_count),
        lastCommitHash: stateByPath.get(row.repo_path)?.last_commit_hash || null,
        lastScanAt: stateByPath.get(row.repo_path)?.last_scan_at || null,
      })),
    });
  });

  app.get('/api/workspace/entities', async (c) => {
    const limit = parseInt(c.req.query('limit') || '100');
    const repo = repoFor(c.req.query('repoPath'));
    const entities = await repo.findAll(limit, 0);
    const total = await repo.count();
    return c.json({ entities, total, limit });
  });

  app.get('/api/workspace/entities/search/:query', async (c) => {
    const query = c.req.param('query');
    const repo = repoFor(c.req.query('repoPath'));
    const entities = await repo.search(query);
    return c.json({ entities });
  });

  app.get('/api/workspace/entities/type/:type', async (c) => {
    const type = c.req.param('type');
    const repo = repoFor(c.req.query('repoPath'));
    const entities = await repo.findByType(type as any);
    return c.json({ entities });
  });

  app.get('/api/workspace/entities/:stableId', async (c) => {
    const stableId = c.req.param('stableId');
    const entity = await workspaceEntityRepo.findByStableId(stableId);
    if (!entity) return c.json({ error: 'Entity not found' }, 404);
    return c.json({ entity });
  });

  app.post('/api/workspace/qa/ask', async (c) => {
    const body: { question?: string; repoPath?: string } = await c.req.json().catch(() => ({}));
    const question = (body.question || '').trim();
    if (!question) {
      return c.json({ error: 'question is required' }, 400);
    }
    // Optional repoPath scopes the question to a single repository; "all"/empty uses the cross-repo service.
    const qa = body.repoPath && body.repoPath !== 'all'
      ? new QaService(
          new EntityRepository(config.pgPool, body.repoPath),
          new RelationshipRepository(config.pgPool, body.repoPath),
          new CommitRepository(config.pgPool, body.repoPath),
          config.graphClient, config.pgPool, false, body.repoPath
        )
      : workspaceQa;
    const answer = await qa.ask(question);
    return c.json(answer);
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
  const log = config.logger || getLogger({ component: 'api', repoPath: config.repoPath });

  serve({
    fetch: app.fetch,
    port: config.port,
    hostname: config.host,
  }, (info) => {
    log.info({ url: `http://${config.host}:${info.port}` }, 'API server running');
    if (webDir) {
      log.info({ url: `http://${config.host}:${info.port}/` }, 'Frontend available');
    }
  });
}
