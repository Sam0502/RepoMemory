import { Pool } from 'pg';
import { EntityRepository, RelationshipRepository, CommitRepository, TraversalService } from '@repo-memory/storage';
import { ChangeAnalyzer } from '@repo-memory/analysis';
import type { EmbeddingProvider } from '@repo-memory/analysis';
import { ContextPackBuilder, QaService, makeChangeAnalyzer } from '@repo-memory/services';

export interface McpServerConfig {
  repoPath: string;
  traversal: TraversalService;
  pgPool: Pool;
  embedder?: EmbeddingProvider;
}

// All repositories and services the MCP tool handlers need. Mirrors the wiring
// in packages/api/src/server.ts so both surfaces read the same stores.
export interface McpServices {
  repoPath: string;
  pgPool: Pool;
  traversal: TraversalService;
  entityRepo: EntityRepository;
  relationshipRepo: RelationshipRepository;
  commitRepo: CommitRepository;
  workspaceEntityRepo: EntityRepository;
  workspaceRelationshipRepo: RelationshipRepository;
  workspaceCommitRepo: CommitRepository;
  changeAnalyzer: ChangeAnalyzer;
  qaService: QaService;
  workspaceQa: QaService;
  contextBuilder: ContextPackBuilder;
  workspaceContextBuilder: ContextPackBuilder;
  embedder?: EmbeddingProvider;
}

export function createMcpServices(config: McpServerConfig): McpServices {
  const { pgPool, repoPath, traversal } = config;

  const entityRepo = new EntityRepository(pgPool, repoPath);
  const relationshipRepo = new RelationshipRepository(pgPool, repoPath);
  const commitRepo = new CommitRepository(pgPool, repoPath);
  const workspaceEntityRepo = new EntityRepository(pgPool, '');
  const workspaceRelationshipRepo = new RelationshipRepository(pgPool, '');
  const workspaceCommitRepo = new CommitRepository(pgPool, '');

  const changeAnalyzer = makeChangeAnalyzer(pgPool);

  const qaService = new QaService(entityRepo, relationshipRepo, commitRepo, traversal, pgPool, false, repoPath);
  const workspaceQa = new QaService(
    workspaceEntityRepo,
    workspaceRelationshipRepo,
    workspaceCommitRepo,
    traversal,
    pgPool,
    true,
    ''
  );

  const contextBuilder = new ContextPackBuilder(entityRepo, commitRepo, traversal, {
    embedder: config.embedder,
    changeAnalyzer,
    relationshipRepo,
    repoPath,
  });
  const workspaceContextBuilder = new ContextPackBuilder(workspaceEntityRepo, workspaceCommitRepo, traversal);

  return {
    repoPath,
    pgPool,
    traversal,
    entityRepo,
    relationshipRepo,
    commitRepo,
    workspaceEntityRepo,
    workspaceRelationshipRepo,
    workspaceCommitRepo,
    changeAnalyzer,
    qaService,
    workspaceQa,
    contextBuilder,
    workspaceContextBuilder,
    embedder: config.embedder,
  };
}
