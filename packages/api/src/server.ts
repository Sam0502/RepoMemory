import { Hono } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { serve } from '@hono/node-server';
import type { ServerType } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { EntityRepository, RelationshipRepository, CommitRepository, JobRepository, TraversalService, listWorkspaceRepos } from '@repo-memory/storage';
import { parseDomainConfig, streamDeadCode, streamBoundaries, resolveBatchSize } from '@repo-memory/analysis';
import type { DomainConfig, EmbeddingProvider } from '@repo-memory/analysis';
import { EntityType, RelationshipType, JobType, getLogger, metrics, registerDefaultMetrics } from '@repo-memory/shared';
import type { Logger, Job, RepoStatus } from '@repo-memory/shared';
import type { Pool } from 'pg';
import { readFileSync } from 'fs';
import { join } from 'path';
import { randomUUID } from 'crypto';
import { ContextPackBuilder, QaService, makeChangeAnalyzer, readEntitySource, MAX_SOURCE_LINES } from '@repo-memory/services';

class HttpError extends Error {
  constructor(public readonly status: number, message: string) {
    super(message);
  }
}

// Parse an integer query parameter with bounds; throws HttpError(400) on invalid input.
function intParam(
  value: string | null | undefined,
  def: number,
  opts: { min?: number; max?: number } = {}
): number {
  if (value === undefined || value === null || value === '') return def;
  if (!/^-?\d+$/.test(value)) throw new HttpError(400, `Expected an integer, got "${value}"`);
  const n = Number(value);
  if (opts.min !== undefined && n < opts.min) throw new HttpError(400, `Value must be >= ${opts.min}`);
  if (opts.max !== undefined && n > opts.max) throw new HttpError(400, `Value must be <= ${opts.max}`);
  return n;
}

function requireEntityType(type: string): EntityType {
  if (!(Object.values(EntityType) as string[]).includes(type)) {
    throw new HttpError(400, `Unknown entity type: "${type}"`);
  }
  return type as EntityType;
}

function requireRelationshipType(type: string): RelationshipType {
  if (!(Object.values(RelationshipType) as string[]).includes(type)) {
    throw new HttpError(400, `Unknown relationship type: "${type}"`);
  }
  return type as RelationshipType;
}

function requireJobType(type: string): JobType {
  if (!(Object.values(JobType) as string[]).includes(type)) {
    throw new HttpError(400, `Unknown job type: "${type}"`);
  }
  return type as JobType;
}

// Normalize request paths for metric labels so per-entity/hash labels don't
// create unbounded Prometheus cardinality.
function metricPath(path: string): string {
  return path
    .replace(/\/[0-9a-fA-F]{20,}/g, '/:hash')
    .replace(/\/[0-9a-fA-F]{16}/g, '/:id')
    .replace(/\/[^/]+\.[^/]+$/g, '/:file')
    .replace(/\d+/g, ':n');
}

export interface ApiConfig {
  port: number;
  host: string;
  repoPath: string;
  traversal: TraversalService;
  pgPool: Pool;
  logger?: Logger;
  // Optional embedding provider for semantic task-pack seeding. When absent,
  // task context packs fall back to keyword search.
  embedder?: EmbeddingProvider;
  // Optional job runner (wired from the CLI's initialized orchestrator). When
  // absent, the POST job endpoints respond 501 but job history stays readable.
  runJob?: (type: JobType, repoPath?: string) => Promise<Job>;
  // Optional live-status provider (wired from the CLI's `watch` mode). When
  // absent, `GET /api/status` reports the repo as not being watched.
  getStatus?: () => Promise<RepoStatus>;
}

export function createApp(config: ApiConfig, webDir?: string): Hono {
  const app = new Hono();
  const traversal = config.traversal;
  const log = config.logger || getLogger({ component: 'api', repoPath: config.repoPath });
  registerDefaultMetrics();
  const entityRepo = new EntityRepository(config.pgPool, config.repoPath);
  const relationshipRepo = new RelationshipRepository(config.pgPool, config.repoPath);
  const commitRepo = new CommitRepository(config.pgPool, config.repoPath);
  const jobRepo = new JobRepository(config.pgPool);
  const qaService = new QaService(entityRepo, relationshipRepo, commitRepo, config.traversal, config.pgPool, false, config.repoPath);

  // Unfiltered repositories for workspace-wide (cross-repo) queries.
  // Entity stable IDs are namespaced by repo path, so cross-repo lookups are safe.
  const workspaceEntityRepo = new EntityRepository(config.pgPool, '');
  const workspaceRelationshipRepo = new RelationshipRepository(config.pgPool, '');
  const workspaceCommitRepo = new CommitRepository(config.pgPool, '');
  const workspaceContextBuilder = new ContextPackBuilder(workspaceEntityRepo, workspaceCommitRepo, config.traversal);
  const workspaceQa = new QaService(workspaceEntityRepo, workspaceRelationshipRepo, workspaceCommitRepo, config.traversal, config.pgPool, true, '');

  // Resolve a repo filter value ("all" / empty = every repo) to a scoped repo instance.
  const repoFor = (repoPath: string | undefined): EntityRepository =>
    repoPath && repoPath !== 'all' ? new EntityRepository(config.pgPool, repoPath) : workspaceEntityRepo;

  // --- Change analysis (churn / risk / drift) ------------------------------
  // One shared analyzer; its providers are lazy per repo path, so scoped and
  // cross-repo questions alike read the right store.
  const changeAnalyzer = makeChangeAnalyzer(config.pgPool);

  // Request logging + metrics: capture method/path/status/duration and correlate
  // logs via X-Request-Id. Runs first so it also measures CORS + static serving.
  const isApiRequest = (path: string): boolean =>
    path.startsWith('/api/') || path === '/health' || path === '/metrics';

  app.use('*', async (c, next) => {
    const requestId = c.req.header('x-request-id') || randomUUID();
    c.header('X-Request-Id', requestId);

    const start = performance.now();
    let status = 500;
    let counted = false;
    const countOnce = (s: number) => {
      if (counted) return;
      counted = true;
      metrics.inc('repo_memory_api_requests_total', {
        method: c.req.method,
        path: metricPath(c.req.path),
        status: String(s),
      });
    };
    try {
      await next();
      status = c.res.status || 404;
      countOnce(status);
    } catch (err) {
      status = err instanceof HttpError ? err.status : 500;
      countOnce(status);
      throw err;
    } finally {
      const durationMs = performance.now() - start;

      metrics.observe('repo_memory_api_request_duration_seconds', durationMs / 1000);

      const fields = { requestId, method: c.req.method, path: c.req.path, status, durationMs };
      if (isApiRequest(c.req.path)) {
        log.info(fields, 'request completed');
      } else {
        log.debug(fields, 'request completed');
      }
    }
  });

  // CORS for frontend. Defaults to the loopback origin; override with CORS_ORIGIN.
  const corsOrigin = process.env.CORS_ORIGIN || 'http://localhost:3000';
  app.use('*', async (c, next) => {
    c.header('Access-Control-Allow-Origin', corsOrigin);
    c.header('Vary', 'Origin');
    c.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    c.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    if (c.req.method === 'OPTIONS') {
      return new Response('', { status: 204 });
    }
    await next();
  });

  // Optional bearer-token auth for /api/* (set REPO_MEMORY_API_TOKEN).
  const apiToken = process.env.REPO_MEMORY_API_TOKEN;
  if (apiToken) {
    app.use('/api/*', async (c, next) => {
      if (c.req.header('authorization') !== `Bearer ${apiToken}`) {
        return c.json({ error: 'Unauthorized' }, 401);
      }
      await next();
    });
  }

  // Bootstrap config for the frontend: exposes the API token (when set) so the
  // same-origin page can authenticate its own /api/* requests. Served outside
  // /api/* because the page needs it before it can authenticate anything.
  // Loopback-only: off-host callers receive an empty token so a LAN peer can't
  // steal the bearer. Set ALLOW_TOKEN_BOOTSTRAP=false to disable entirely.
  app.get('/config.js', (c) => {
    const allowBootstrap = (process.env.ALLOW_TOKEN_BOOTSTRAP ?? 'true') !== 'false';
    const host = (c.req.header('host') || '').toLowerCase();
    const hostname = host.split(':')[0];
    const isLoopback =
      hostname === '' ||
      hostname === 'localhost' ||
      hostname === '127.0.0.1' ||
      hostname === '::1' ||
      hostname === '[::1]';
    const token = allowBootstrap && isLoopback ? process.env.REPO_MEMORY_API_TOKEN || '' : '';
    return c.text(`window.REPO_MEMORY_API_TOKEN = ${JSON.stringify(token)};\n`, 200, {
      'Content-Type': 'text/javascript; charset=utf-8',
      'Cache-Control': 'no-store',
    });
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

  // Prometheus metrics (disable with METRICS_ENABLED=false). When API auth is
  // enabled, require the bearer token like /api/* so counts aren't leaked.
  if ((process.env.METRICS_ENABLED ?? 'true') !== 'false') {
    app.get('/metrics', (c) => {
      const apiToken = process.env.REPO_MEMORY_API_TOKEN;
      if (apiToken && c.req.header('authorization') !== `Bearer ${apiToken}`) {
        return c.json({ error: 'Unauthorized' }, 401);
      }
      registerDefaultMetrics();
      return c.text(metrics.render(), 200, {
        'Content-Type': 'text/plain; version=0.0.4; charset=utf-8',
      });
    });
  }

  // Entity endpoints
  app.get('/api/entities', async (c) => {
    const limit = intParam(c.req.query('limit'), 100, { min: 1, max: 1000 });
    const offset = intParam(c.req.query('offset'), 0, { min: 0 });
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
    const type = requireEntityType(c.req.param('type'));
    const limit = intParam(c.req.query('limit'), 100, { min: 1, max: 1000 });
    const entities = await entityRepo.findByType(type, limit);
    return c.json({ entities });
  });

  app.get('/api/entities/file/*', async (c) => {
    const filePath = c.req.param('*') || c.req.param('filePath') || '';
    const entities = await entityRepo.findByFilePath(filePath);
    return c.json({ entities });
  });

  // Legacy single-segment alias (nested paths should use /api/entities/file/*).
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
    const limit = intParam(c.req.query('limit'), 100, { min: 1, max: 1000 });

    if (sourceId) {
      const relationships = (await relationshipRepo.findBySourceId(sourceId)).slice(0, limit);
      return c.json({ relationships });
    }

    if (targetId) {
      const relationships = (await relationshipRepo.findByTargetId(targetId)).slice(0, limit);
      return c.json({ relationships });
    }

    if (type) {
      const relationships = await relationshipRepo.findByType(requireRelationshipType(type), limit);
      return c.json({ relationships });
    }

    return c.json({ error: 'Provide sourceId, targetId, or type parameter' }, 400);
  });

  // Graph traversal endpoints
  app.get('/api/graph/traverse/:stableId', async (c) => {
    const stableId = c.req.param('stableId');
    const depth = intParam(c.req.query('depth'), 1, { min: 1, max: 20 });

    const entity = await workspaceEntityRepo.findByStableId(stableId);
    if (!entity) {
      return c.json({ error: 'Entity not found' }, 404);
    }

    const scope = entity.repoPath || config.repoPath;
    // Real 1-hop graph neighbourhood (not same-file heuristic).
    const [depRows, dependentRows] = await Promise.all([
      traversal.findDependencies(stableId, scope),
      traversal.findDependents(stableId, scope),
    ]);
    const dependencies = depRows.map(d => d.entity).slice(0, 20);
    const dependents = dependentRows.map(d => d.entity).slice(0, 20);

    return c.json({
      entity,
      dependencies,
      dependents,
      depth,
    });
  });

  app.get('/api/graph/dependencies/:stableId', async (c) => {
    const stableId = c.req.param('stableId');
    const limit = intParam(c.req.query('limit'), 50, { min: 1, max: 500 });
    const [rows, total] = await Promise.all([
      traversal.findDependencies(stableId, config.repoPath, limit),
      traversal.countDependencies(stableId, config.repoPath),
    ]);
    return c.json({ dependencies: rows.map(d => d.entity), count: rows.length, total });
  });

  app.get('/api/graph/dependents/:stableId', async (c) => {
    const stableId = c.req.param('stableId');
    const limit = intParam(c.req.query('limit'), 50, { min: 1, max: 500 });
    const [rows, total] = await Promise.all([
      traversal.findDependents(stableId, config.repoPath, limit),
      traversal.countDependents(stableId, config.repoPath),
    ]);
    return c.json({ dependents: rows.map(d => d.entity), count: rows.length, total });
  });

  app.get('/api/graph/transitive/:stableId', async (c) => {
    const stableId = c.req.param('stableId');
    const maxDepth = intParam(c.req.query('maxDepth'), 5, { min: 1, max: 6 });
    const entities = await traversal.findTransitiveDependencies(stableId, maxDepth, config.repoPath);
    return c.json({ entities });
  });

  app.get('/api/entities/:stableId/members', async (c) => {
    const stableId = c.req.param('stableId');
    const limit = intParam(c.req.query('limit'), 100, { min: 1, max: 500 });
    const entity = await workspaceEntityRepo.findByStableId(stableId);
    if (!entity) {
      return c.json({ error: 'Entity not found' }, 404);
    }
    const scope = entity.repoPath || config.repoPath;
    const [rows, total] = await Promise.all([
      traversal.findMembers(stableId, scope, limit),
      traversal.countMembers(stableId, scope),
    ]);
    return c.json({ entity, members: rows.map(d => d.entity), count: rows.length, total });
  });

  app.get('/api/entities/:stableId/source', async (c) => {
    const stableId = c.req.param('stableId');
    const maxLines = intParam(c.req.query('maxLines'), MAX_SOURCE_LINES, { min: 1, max: 10000 });
    const entity = (await entityRepo.findByStableId(stableId)) || (await workspaceEntityRepo.findByStableId(stableId));
    if (!entity) {
      return c.json({ error: 'Entity not found' }, 404);
    }
    const source = await readEntitySource(entity.repoPath || config.repoPath, entity, maxLines);
    if (!source) {
      return c.json({ error: 'Source not available for this entity' }, 404);
    }
    return c.json(source);
  });

  // Similar entities endpoint (semantic search)
  app.get('/api/entities/similar/:stableId', async (c) => {
    const stableId = c.req.param('stableId');
    const limit = intParam(c.req.query('limit'), 10, { min: 1, max: 50 });
    const entity = await workspaceEntityRepo.findByStableId(stableId);
    if (!entity) {
      return c.json({ error: 'Entity not found' }, 404);
    }
    const similar = await workspaceEntityRepo.findSimilar(stableId, limit);
    return c.json({ entity, similar });
  });

  // Commit endpoints
  app.get('/api/commits', async (c) => {
    const limit = intParam(c.req.query('limit'), 20, { min: 1, max: 1000 });
    const repoPath = c.req.query('repoPath');
    const commits = repoPath && repoPath !== 'all'
      ? await new CommitRepository(config.pgPool, repoPath).findRecent(limit)
      : await workspaceCommitRepo.findRecent(limit);
    return c.json({ commits });
  });

  app.get('/api/commits/:hash', async (c) => {
    const hash = c.req.param('hash');
    // Prefer the served repo on hash collisions across repos.
    const commit = (await commitRepo.findByHash(hash)) || (await workspaceCommitRepo.findByHash(hash));
    if (!commit) {
      return c.json({ error: 'Commit not found' }, 404);
    }
    const scopedFileRepo = new CommitRepository(config.pgPool, commit.repoPath || config.repoPath);
    const fileChanges = await scopedFileRepo.getFileChanges(hash);
    return c.json({ commit, fileChanges });
  });

  // Architecture graph - file-level view
  app.get('/api/graph/architecture', async (c) => {
    const repoFilter = c.req.query('repoPath') || config.repoPath;
    const isAll = repoFilter === 'all' || repoFilter === '';

    if (!isAll) {
      const known = await config.pgPool.query(
        'SELECT 1 FROM repo_state WHERE repo_path = $1 LIMIT 1',
        [repoFilter]
      );
      if (known.rowCount === 0) {
        return c.json({ error: `Unknown repo: ${repoFilter}` }, 400);
      }
    }

    // Get all unique files with entity counts
    const filesQuery = isAll
      ? `SELECT file_path, COUNT(*) as entity_count,
                ARRAY_AGG(type) as entity_types
         FROM entities 
         GROUP BY file_path 
         ORDER BY file_path
         LIMIT 1000`
      : `SELECT file_path, COUNT(*) as entity_count,
                ARRAY_AGG(type) as entity_types
         FROM entities 
         WHERE repo_path = $1
         GROUP BY file_path 
         ORDER BY file_path
         LIMIT 1000`;
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

    const truncated = filesResult.rowCount === 1000;
    return c.json({ files, links, truncated });
  });

  // Context pack endpoint (scoped to the served repo first to avoid cross-repo leaks)
  app.get('/api/context-pack/:stableId', async (c) => {
    const stableId = c.req.param('stableId');
    const tokenBudget = intParam(c.req.query('tokenBudget'), 4000, { min: 100, max: 1_000_000 });
    const scopedEntity = await entityRepo.findByStableId(stableId);
    const builder = scopedEntity
      ? new ContextPackBuilder(entityRepo, commitRepo, config.traversal)
      : workspaceContextBuilder;
    const pack = await builder.build(stableId, tokenBudget);
    if (!pack) {
      return c.json({ error: 'Entity not found' }, 404);
    }
    return c.json(pack);
  });

  // Task context pack endpoint: seed focal entities from a task description
  // (keyword + optional semantic), expand the graph, attach commits/risk and
  // boundary signals, all trimmed to a token budget.
  app.post('/api/context-packs/task', async (c) => {
    const body: { task?: string; repoPath?: string; tokenBudget?: number; maxFocal?: number } = await c
      .req.json()
      .catch(() => ({}));
    const task = (body.task || '').trim();
    if (!task) {
      return c.json({ error: 'task is required' }, 400);
    }
    const scope = body.repoPath && body.repoPath !== 'all' ? body.repoPath : config.repoPath;
    const tokenBudget =
      typeof body.tokenBudget === 'number' && Number.isInteger(body.tokenBudget)
        ? Math.min(Math.max(body.tokenBudget, 100), 1_000_000)
        : 4000;
    const maxFocal =
      typeof body.maxFocal === 'number' && Number.isInteger(body.maxFocal)
        ? Math.min(Math.max(body.maxFocal, 1), 50)
        : 10;

    const builder = new ContextPackBuilder(
      new EntityRepository(config.pgPool, scope),
      new CommitRepository(config.pgPool, scope),
      config.traversal,
      {
        embedder: config.embedder,
        changeAnalyzer,
        relationshipRepo: new RelationshipRepository(config.pgPool, scope),
        repoPath: scope,
      }
    );

    const pack = await builder.buildTaskContext(task, { tokenBudget, maxFocal });
    if (!pack) {
      return c.json({ error: 'No entities matched the task description. Try entity search instead.' }, 404);
    }
    return c.json(pack);
  });

  // Impact analysis
  app.get('/api/analysis/impact/:stableId', async (c) => {
    const stableId = c.req.param('stableId');
    return c.json(await qaService.computeImpact(stableId));
  });

  // Dead code detection (streamed in windows; ?batchSize= tunes page size)
  app.get('/api/analysis/dead-code', async (c) => {
    const includeExported = c.req.query('includeExported') === 'true';
    const batchSize = intParam(c.req.query('batchSize'), resolveBatchSize(), { min: 1, max: 100000 });

    const report = await streamDeadCode(
      { page: (offset, limit) => entityRepo.findAll(limit, offset) },
      {
        page: (offset, limit) =>
          relationshipRepo.findByTypesPaged(
            [RelationshipType.CALLS, RelationshipType.REFERENCES, RelationshipType.IMPORTS, RelationshipType.EXTENDS, RelationshipType.IMPLEMENTS, RelationshipType.HANDLES],
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
    const limit = intParam(c.req.query('limit'), 500, { min: 1, max: 10000 });
    const ownership = await commitRepo.getOwnership(config.repoPath, limit);
    return c.json({ ownership });
  });

  // Architecture boundary validation (streamed in windows; ?batchSize= tunes page size)
  app.get('/api/analysis/boundaries', async (c) => {
    const batchSize = intParam(c.req.query('batchSize'), resolveBatchSize(), { min: 1, max: 100000 });

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
    const limit = intParam(c.req.query('limit'), 50, { min: 1, max: 100000 });
    const days = c.req.query('days') !== undefined ? intParam(c.req.query('days'), 0, { min: 1 }) : undefined;
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
    const info = await changeAnalyzer.computeEntityChange(entity.repoPath || config.repoPath, stableId);
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
    const limit = intParam(c.req.query('limit'), 50, { min: 1, max: 1000 });
    const type = c.req.query('type');
    const jobs = type
      ? await jobRepo.findByType(requireJobType(type), limit)
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
    // Repair mutates the underlying data; drop QA caches so answers re-derive
    // from the repaired snapshot.
    qaService.invalidateCache();
    workspaceQa.invalidateCache();
    return c.json(job);
  });

  // --- Workspace (cross-repo) endpoints -------------------------------------

  app.get('/api/workspace/repos', async (c) => {
    const repos = await listWorkspaceRepos(config.pgPool);
    return c.json({
      repos: repos.map(row => ({
        repoPath: row.repoPath,
        entityCount: row.entityCount,
        commitCount: row.commitCount,
        lastCommitHash: row.lastCommitHash,
        lastScanAt: row.lastScanAt,
      })),
    });
  });

  app.get('/api/workspace/entities', async (c) => {
    const limit = intParam(c.req.query('limit'), 100, { min: 1, max: 1000 });
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
    const type = requireEntityType(c.req.param('type'));
    const repo = repoFor(c.req.query('repoPath'));
    const entities = await repo.findByType(type);
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
          config.traversal, config.pgPool, false, body.repoPath
        )
      : workspaceQa;
    const answer = await qa.ask(question);
    return c.json(answer);
  });

  // Central error handler: structured JSON (no stack). Metrics are counted once
  // in the request middleware (which rethrows after counting), so don't count here.
  app.onError((err, c) => {
    const status = err instanceof HttpError ? err.status : 500;
    const message = err instanceof HttpError ? err.message : 'Internal Server Error';
    if (status >= 500) {
      log.error({ err, path: c.req.path }, 'request failed');
    } else {
      log.debug({ err, path: c.req.path }, 'request rejected');
    }
    return c.json({ error: message }, status as ContentfulStatusCode);
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

export function startServer(config: ApiConfig, webDir?: string): ServerType {
  const app = createApp(config, webDir);
  const log = config.logger || getLogger({ component: 'api', repoPath: config.repoPath });
  const host = config.host || '127.0.0.1';

  return serve({
    fetch: app.fetch,
    port: config.port,
    hostname: host,
  }, (info) => {
    log.info({ url: `http://${host}:${info.port}` }, 'API server running');
    if (webDir) {
      log.info({ url: `http://${host}:${info.port}/` }, 'Frontend available');
    }
  });
}
