import { Pool } from 'pg';
import { GraphClient } from '@repo-memory/graph';
import { EntityRepository, RelationshipRepository, CommitRepository } from '@repo-memory/storage';
import { ChangeAnalyzer, resolveBatchSize } from '@repo-memory/analysis';
import type { EmbeddingProvider } from '@repo-memory/analysis';
import { ContextPackBuilder, QaService } from '@repo-memory/services';
import { RelationshipType } from '@repo-memory/shared';
import type { Entity, Relationship } from '@repo-memory/shared';

export interface McpServerConfig {
  repoPath: string;
  graphClient: GraphClient;
  pgPool: Pool;
  embedder?: EmbeddingProvider;
}

// All repositories and services the MCP tool handlers need. Mirrors the wiring
// in packages/api/src/server.ts so both surfaces read the same stores.
export interface McpServices {
  repoPath: string;
  pgPool: Pool;
  graphClient: GraphClient;
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

const GRAPH_RELATIONSHIP_TYPES = [
  RelationshipType.CALLS,
  RelationshipType.REFERENCES,
  RelationshipType.IMPORTS,
  RelationshipType.EXTENDS,
  RelationshipType.IMPLEMENTS,
  RelationshipType.HANDLES,
];

export function createMcpServices(config: McpServerConfig): McpServices {
  const { pgPool, repoPath, graphClient } = config;

  const entityRepo = new EntityRepository(pgPool, repoPath);
  const relationshipRepo = new RelationshipRepository(pgPool, repoPath);
  const commitRepo = new CommitRepository(pgPool, repoPath);
  const workspaceEntityRepo = new EntityRepository(pgPool, '');
  const workspaceRelationshipRepo = new RelationshipRepository(pgPool, '');
  const workspaceCommitRepo = new CommitRepository(pgPool, '');

  const changeAnalyzer = new ChangeAnalyzer({
    fileChurnRows: (p, days) => new CommitRepository(pgPool, p).getFileChurn(p, 100000, days),
    entityPage: (p, offset, limit) => new EntityRepository(pgPool, p).findAll(limit, offset),
    relationshipPage: (p, offset, limit) =>
      new RelationshipRepository(pgPool, p).findByTypesPaged(GRAPH_RELATIONSHIP_TYPES, limit, offset),
    entityByStableId: (p, stableId) => new EntityRepository(pgPool, p).findByStableId(stableId),
    entities: async (p) => {
      const rows: Entity[] = [];
      const limit = resolveBatchSize();
      let offset = 0;
      while (true) {
        const batch = await new EntityRepository(pgPool, p).findAll(limit, offset);
        rows.push(...batch);
        if (batch.length < limit) break;
        offset += limit;
      }
      return rows;
    },
    relationships: async (p) => {
      const rows: Relationship[] = [];
      const limit = resolveBatchSize();
      let offset = 0;
      while (true) {
        const batch = await new RelationshipRepository(pgPool, p).findByTypesPaged(GRAPH_RELATIONSHIP_TYPES, limit, offset);
        rows.push(...batch);
        if (batch.length < limit) break;
        offset += limit;
      }
      return rows;
    },
    lastCommitDate: (p) => new CommitRepository(pgPool, p).getLastCommitDate(p),
  });

  const qaService = new QaService(entityRepo, relationshipRepo, commitRepo, graphClient, pgPool, false, repoPath);
  const workspaceQa = new QaService(
    workspaceEntityRepo,
    workspaceRelationshipRepo,
    workspaceCommitRepo,
    graphClient,
    pgPool,
    true,
    ''
  );

  const contextBuilder = new ContextPackBuilder(entityRepo, commitRepo, graphClient, {
    embedder: config.embedder,
    changeAnalyzer,
    relationshipRepo,
    repoPath,
  });
  const workspaceContextBuilder = new ContextPackBuilder(workspaceEntityRepo, workspaceCommitRepo, graphClient);

  return {
    repoPath,
    pgPool,
    graphClient,
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
