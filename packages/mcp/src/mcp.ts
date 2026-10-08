import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { readFileSync } from 'fs';
import { join } from 'path';
import { parseDomainConfig, streamBoundaries, streamDeadCode, resolveBatchSize } from '@repo-memory/analysis';
import { EntityRepository, RelationshipRepository, CommitRepository, listWorkspaceRepos } from '@repo-memory/storage';
import { RelationshipType } from '@repo-memory/shared';
import { ContextPackBuilder, QaService, readEntitySource, MAX_SOURCE_LINES } from '@repo-memory/services';
import { createMcpServices } from './services.js';
import type { McpServerConfig, McpServices } from './services.js';

const BOUNDARY_TYPES = [
  RelationshipType.IMPORTS,
  RelationshipType.CALLS,
  RelationshipType.REFERENCES,
  RelationshipType.EXTENDS,
  RelationshipType.IMPLEMENTS,
  RelationshipType.HANDLES,
];

const DEAD_CODE_TYPES = [
  RelationshipType.CALLS,
  RelationshipType.REFERENCES,
  RelationshipType.IMPORTS,
  RelationshipType.EXTENDS,
  RelationshipType.IMPLEMENTS,
  RelationshipType.HANDLES,
];

function toolResult(data: unknown): CallToolResult {
  return {
    content: [{ type: 'text', text: JSON.stringify(data, null, 2) }],
    structuredContent: data as CallToolResult['structuredContent'],
  };
}

function loadDomainConfig(repoPath: string) {
  try {
    return parseDomainConfig(readFileSync(join(repoPath, '.repomemory', 'boundaries.json'), 'utf-8'));
  } catch {
    return undefined;
  }
}

// Scoped repo instances mirror the API's `repoFor` semantics: undefined or
// 'all' means the workspace (every scanned repo).
function repoFor(services: McpServices, repoPath: string | undefined): EntityRepository {
  return repoPath && repoPath !== 'all'
    ? new EntityRepository(services.pgPool, repoPath)
    : services.workspaceEntityRepo;
}

// A task-context builder scoped to a repo. Reuses the lazy per-repo
// ChangeAnalyzer, which accepts any repo path, so churn/risk stay accurate.
function taskBuilderFor(services: McpServices, repoPath: string): ContextPackBuilder {
  if (repoPath === services.repoPath) return services.contextBuilder;
  return new ContextPackBuilder(
    new EntityRepository(services.pgPool, repoPath),
    new CommitRepository(services.pgPool, repoPath),
    services.traversal,
    {
      embedder: services.embedder,
      changeAnalyzer: services.changeAnalyzer,
      relationshipRepo: new RelationshipRepository(services.pgPool, repoPath),
      repoPath,
    }
  );
}

function registerTools(server: McpServer, services: McpServices): void {
  // --- Entity / graph reads ------------------------------------------------

  server.registerTool(
    'entity_get',
    {
      title: 'Get entity',
      description: 'Fetch a single entity by its stable ID (cross-repo).',
      inputSchema: z.object({ stableId: z.string().describe('Stable entity ID') }),
    },
    async ({ stableId }) => {
      const entity = await services.workspaceEntityRepo.findByStableId(stableId);
      return toolResult(entity ? { entity } : { error: `Entity not found: ${stableId}` });
    }
  );

  server.registerTool(
    'entity_search',
    {
      title: 'Search entities',
      description: 'Keyword search over entities in the configured repository.',
      inputSchema: z.object({
        query: z.string().describe('Search terms, e.g. "createUser"'),
        limit: z.number().int().min(1).max(200).optional(),
      }),
    },
    async ({ query, limit }) => {
      const entities = (await services.entityRepo.search(query)).slice(0, limit ?? 20);
      return toolResult({ entities, count: entities.length });
    }
  );

  server.registerTool(
    'entity_similar',
    {
      title: 'Find similar entities',
      description: 'Semantically similar entities (by embedding) to a stable ID.',
      inputSchema: z.object({
        stableId: z.string(),
        limit: z.number().int().min(1).max(50).optional(),
      }),
    },
    async ({ stableId, limit }) => {
      const entity = await services.workspaceEntityRepo.findByStableId(stableId);
      if (!entity) return toolResult({ error: `Entity not found: ${stableId}` });
      const similar = await services.workspaceEntityRepo.findSimilar(stableId, limit ?? 10);
      return toolResult({ entity, similar });
    }
  );

  server.registerTool(
    'entity_dependencies',
    {
      title: 'Get dependencies',
      description: 'Entities an entity depends on (direct, or transitive to a depth).',
      inputSchema: z.object({
        stableId: z.string(),
        depth: z.number().int().min(1).max(6).optional(),
      }),
    },
    async ({ stableId, depth }) => {
      const d = depth ?? 1;
      if (d <= 1) {
        const [rows, total] = await Promise.all([
          services.traversal.findDependencies(stableId, services.repoPath),
          services.traversal.countDependencies(stableId, services.repoPath),
        ]);
        const entities = rows.map(x => x.entity);
        return toolResult({ stableId, depth: d, entities, count: entities.length, total });
      }
      const entities = await services.traversal.findTransitiveDependencies(stableId, d, services.repoPath);
      return toolResult({ stableId, depth: d, entities, count: entities.length, total: entities.length });
    }
  );

  server.registerTool(
    'entity_dependents',
    {
      title: 'Get dependents',
      description: 'Entities that depend on an entity (direct, or transitive to a depth).',
      inputSchema: z.object({
        stableId: z.string(),
        depth: z.number().int().min(1).max(6).optional(),
      }),
    },
    async ({ stableId, depth }) => {
      const d = depth ?? 1;
      if (d <= 1) {
        const [rows, total] = await Promise.all([
          services.traversal.findDependents(stableId, services.repoPath),
          services.traversal.countDependents(stableId, services.repoPath),
        ]);
        const entities = rows.map(x => x.entity);
        return toolResult({ stableId, depth: d, entities, count: entities.length, total });
      }
      const entities = await services.traversal.findTransitiveDependents(stableId, d, services.repoPath);
      return toolResult({ stableId, depth: d, entities, count: entities.length, total: entities.length });
    }
  );

  server.registerTool(
    'entity_impact',
    {
      title: 'Impact analysis',
      description: 'Direct + indirect dependents and affected files when an entity changes.',
      inputSchema: z.object({ stableId: z.string() }),
    },
    async ({ stableId }) => {
      return toolResult(await services.qaService.computeImpact(stableId));
    }
  );

  server.registerTool(
    'entity_members',
    {
      title: 'Get members',
      description: 'Member entities contained in a class, file, or other parent (methods of a class, top-level symbols of a file).',
      inputSchema: z.object({
        stableId: z.string(),
        limit: z.number().int().min(1).max(500).optional(),
      }),
    },
    async ({ stableId, limit }) => {
      const entity = await services.workspaceEntityRepo.findByStableId(stableId);
      if (!entity) return toolResult({ error: `Entity not found: ${stableId}` });
      const scope = entity.repoPath || services.repoPath;
      const [rows, total] = await Promise.all([
        services.traversal.findMembers(stableId, scope, limit ?? 100),
        services.traversal.countMembers(stableId, scope),
      ]);
      const entities = rows.map(x => x.entity);
      return toolResult({ stableId, entities, count: entities.length, total });
    }
  );

  server.registerTool(
    'entity_source',
    {
      title: 'Get source',
      description: 'Exact source lines for an entity (working-tree content, path-jailed to its repository).',
      inputSchema: z.object({
        stableId: z.string(),
        maxLines: z.number().int().min(1).max(10000).optional(),
      }),
    },
    async ({ stableId, maxLines }) => {
      const entity = await services.workspaceEntityRepo.findByStableId(stableId);
      if (!entity) return toolResult({ error: `Entity not found: ${stableId}` });
      const source = await readEntitySource(entity.repoPath || services.repoPath, entity, maxLines ?? MAX_SOURCE_LINES);
      return toolResult(source ? { source } : { error: `Source not available for: ${stableId}` });
    }
  );

  server.registerTool(
    'context_pack',
    {
      title: 'Entity context pack',
      description: 'A token-budgeted context pack for an entity: dependencies, dependents, similar entities, recent changes.',
      inputSchema: z.object({
        stableId: z.string(),
        tokenBudget: z.number().int().min(100).max(1_000_000).optional(),
      }),
    },
    async ({ stableId, tokenBudget }) => {
      const pack = await services.workspaceContextBuilder.build(stableId, tokenBudget ?? 4000);
      return toolResult(pack ? { pack } : { error: `Entity not found: ${stableId}` });
    }
  );

  server.registerTool(
    'qa_ask',
    {
      title: 'Ask a question',
      description: 'Natural-language question over the configured repository (e.g. "who depends on createUser?").',
      inputSchema: z.object({ question: z.string() }),
    },
    async ({ question }) => {
      const answer = await services.qaService.ask(question);
      return toolResult(answer);
    }
  );

  server.registerTool(
    'task_context',
    {
      title: 'Task context pack',
      description: 'Build a token-budgeted context pack for a task description: focal entities, files, relationships, recent changes, risk and boundary signals.',
      inputSchema: z.object({
        task: z.string().describe('Task description or a stable ID / file path'),
        repoPath: z.string().optional(),
        tokenBudget: z.number().int().min(100).max(1_000_000).optional(),
        maxFocal: z.number().int().min(1).max(50).optional(),
      }),
    },
    async ({ task, repoPath, tokenBudget, maxFocal }) => {
      const scope = repoPath && repoPath !== 'all' ? repoPath : services.repoPath;
      const pack = await taskBuilderFor(services, scope).buildTaskContext(task, {
        tokenBudget: tokenBudget ?? 4000,
        maxFocal: maxFocal ?? 10,
      });
      return toolResult(pack ? { pack } : { error: 'No entities matched the task description. Try entity_search first.' });
    }
  );

  // --- Analysis ------------------------------------------------------------

  server.registerTool(
    'analysis_dead_code',
    {
      title: 'Dead code report',
      description: 'Unreachable symbols in the configured repository.',
      inputSchema: z.object({
        includeExported: z.boolean().optional(),
        batchSize: z.number().int().min(1).max(100_000).optional(),
      }),
    },
    async ({ includeExported, batchSize }) => {
      const report = await streamDeadCode(
        { page: (offset, limit) => services.entityRepo.findAll(limit, offset) },
        { page: (offset, limit) => services.relationshipRepo.findByTypesPaged(DEAD_CODE_TYPES, limit, offset) },
        { batchSize: batchSize ?? resolveBatchSize() }
      );
      return toolResult(includeExported ? report : { ...report, exportedButUnused: [] });
    }
  );

  server.registerTool(
    'analysis_boundaries',
    {
      title: 'Boundary report',
      description: 'Cross-domain edges and violations for the configured repository (uses .repomemory/boundaries.json when present).',
      inputSchema: z.object({
        batchSize: z.number().int().min(1).max(100_000).optional(),
      }),
    },
    async ({ batchSize }) => {
      const report = await streamBoundaries(
        { page: (offset, limit) => services.entityRepo.findAll(limit, offset) },
        { page: (offset, limit) => services.relationshipRepo.findByTypesPaged(BOUNDARY_TYPES, limit, offset) },
        loadDomainConfig(services.repoPath),
        { batchSize: batchSize ?? resolveBatchSize() }
      );
      return toolResult(report);
    }
  );

  server.registerTool(
    'analysis_churn',
    {
      title: 'File churn',
      description: 'Files ranked by commit churn (additions/deletions-weighted) for the configured repository.',
      inputSchema: z.object({
        limit: z.number().int().min(1).max(100_000).optional(),
        days: z.number().int().min(1).optional(),
      }),
    },
    async ({ limit, days }) => {
      const churn = await services.changeAnalyzer.computeFileChurn(services.repoPath, limit ?? 50, days);
      return toolResult({ churn });
    }
  );

  server.registerTool(
    'analysis_risk',
    {
      title: 'Repository risk',
      description: 'Per-file risk scores (churn, fanout, boundary, dead code, staleness) for the configured repository.',
      inputSchema: z.object({}),
    },
    async () => {
      const risk = await services.changeAnalyzer.computeFileRisk(services.repoPath);
      return toolResult({ risk });
    }
  );

  server.registerTool(
    'analysis_risk_entity',
    {
      title: 'Entity change info',
      description: 'Commit count and staleness for a single entity.',
      inputSchema: z.object({ stableId: z.string() }),
    },
    async ({ stableId }) => {
      const entity = await services.workspaceEntityRepo.findByStableId(stableId);
      if (!entity) return toolResult({ error: `Entity not found: ${stableId}` });
      const info = await services.changeAnalyzer.computeEntityChange(entity.repoPath || services.repoPath, stableId);
      return toolResult({ entity: info });
    }
  );

  server.registerTool(
    'analysis_drift',
    {
      title: 'Architecture drift',
      description: 'Drift signals (test gaps, recent boundary violations, unstable public surfaces) for the configured repository.',
      inputSchema: z.object({}),
    },
    async () => {
      const report = await services.changeAnalyzer.detectDrift(services.repoPath);
      return toolResult(report);
    }
  );

  server.registerTool(
    'analysis_ownership',
    {
      title: 'File ownership',
      description: 'Per-file dominant author for the configured repository.',
      inputSchema: z.object({
        limit: z.number().int().min(1).max(10_000).optional(),
      }),
    },
    async ({ limit }) => {
      const ownership = await services.commitRepo.getOwnership(services.repoPath, limit ?? 500);
      return toolResult({ ownership });
    }
  );

  // --- Commits -------------------------------------------------------------

  server.registerTool(
    'commits_recent',
    {
      title: 'Recent commits',
      description: 'Most recent commits, optionally scoped to one repository.',
      inputSchema: z.object({
        limit: z.number().int().min(1).max(1000).optional(),
        repoPath: z.string().optional(),
      }),
    },
    async ({ limit, repoPath }) => {
      const commits =
        repoPath && repoPath !== 'all'
          ? await new CommitRepository(services.pgPool, repoPath).findRecent(limit ?? 20)
          : await services.workspaceCommitRepo.findRecent(limit ?? 20);
      return toolResult({ commits });
    }
  );

  server.registerTool(
    'commit_get',
    {
      title: 'Get commit',
      description: 'Commit details and file changes for a hash.',
      inputSchema: z.object({ hash: z.string() }),
    },
    async ({ hash }) => {
      const commit =
        (await services.commitRepo.findByHash(hash)) ||
        (await services.workspaceCommitRepo.findByHash(hash));
      if (!commit) return toolResult({ error: `Commit not found: ${hash}` });
      const scoped = new CommitRepository(services.pgPool, commit.repoPath || services.repoPath);
      const fileChanges = await scoped.getFileChanges(hash);
      return toolResult({ commit, fileChanges });
    }
  );

  // --- Workspace (cross-repo) ----------------------------------------------

  server.registerTool(
    'workspace_repos',
    {
      title: 'List repositories',
      description: 'Every scanned repository with entity and commit counts.',
      inputSchema: z.object({}),
    },
    async () => {
      const repos = await listWorkspaceRepos(services.pgPool);
      return toolResult({
        repos: repos.map(row => ({
          repoPath: row.repoPath,
          entityCount: row.entityCount,
          commitCount: row.commitCount,
          lastCommitHash: row.lastCommitHash,
          lastScanAt: row.lastScanAt,
        })),
      });
    }
  );

  server.registerTool(
    'workspace_search',
    {
      title: 'Workspace search',
      description: 'Cross-repo entity search; pass repoPath to scope to one repository.',
      inputSchema: z.object({
        query: z.string(),
        repoPath: z.string().optional(),
        limit: z.number().int().min(1).max(200).optional(),
      }),
    },
    async ({ query, repoPath, limit }) => {
      const entities = (await repoFor(services, repoPath).search(query)).slice(0, limit ?? 20);
      return toolResult({ entities, count: entities.length });
    }
  );

  server.registerTool(
    'workspace_qa',
    {
      title: 'Workspace QA',
      description: 'Natural-language question across every scanned repository.',
      inputSchema: z.object({
        question: z.string(),
        repoPath: z.string().optional(),
      }),
    },
    async ({ question, repoPath }) => {
      const scope = repoPath && repoPath !== 'all' ? repoPath : undefined;
      const qa = scope
        ? new QaService(
            new EntityRepository(services.pgPool, scope),
            new RelationshipRepository(services.pgPool, scope),
            new CommitRepository(services.pgPool, scope),
            services.traversal,
            services.pgPool,
            false,
            scope
          )
        : services.workspaceQa;
      const answer = await qa.ask(question);
      return toolResult(answer);
    }
  );
}

export function createMcpServer(config: McpServerConfig): McpServer {
  return createMcpServerFromServices(createMcpServices(config));
}

// Build a server from pre-wired services (used by tests with mocked stores).
export function createMcpServerFromServices(services: McpServices): McpServer {
  const server = new McpServer({ name: 'repo-memory', version: '0.1.0' });
  registerTools(server, services);
  return server;
}

// Spawns the server over stdio (local agent integrations). The process stays
// alive as long as the client keeps the stdio channel open.
export async function serveStdio(config: McpServerConfig): Promise<McpServer> {
  const server = createMcpServer(config);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  return server;
}
