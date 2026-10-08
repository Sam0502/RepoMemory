import { Pool } from 'pg';
import { EntityRepository, RelationshipRepository, CommitRepository } from '@repo-memory/storage';
import { ChangeAnalyzer, resolveBatchSize } from '@repo-memory/analysis';
import { Entity, Relationship, RelationshipType } from '@repo-memory/shared';

const CHANGE_RELATIONSHIP_TYPES = [
  RelationshipType.CALLS,
  RelationshipType.REFERENCES,
  RelationshipType.IMPORTS,
  RelationshipType.EXTENDS,
  RelationshipType.IMPLEMENTS,
  RelationshipType.HANDLES,
];

// Single shared ChangeAnalyzer factory. Providers are lazy per repo path:
// callers pass whichever repo they are answering for, so one cached instance
// serves scoped and cross-repo questions alike.
export function makeChangeAnalyzer(pgPool: Pool): ChangeAnalyzer {
  return new ChangeAnalyzer({
    fileChurnRows: (p, days) => new CommitRepository(pgPool, p).getFileChurn(p, 100000, days),
    entityPage: (p, offset, limit) => new EntityRepository(pgPool, p).findAll(limit, offset),
    relationshipPage: (p, offset, limit) =>
      new RelationshipRepository(pgPool, p).findByTypesPaged(CHANGE_RELATIONSHIP_TYPES, limit, offset),
    entityByStableId: (p, stableId) => new EntityRepository(pgPool, p).findByStableId(stableId),
    entities: async (repoPath) => {
      const repo = new EntityRepository(pgPool, repoPath);
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
      const repo = new RelationshipRepository(pgPool, repoPath);
      const rels: Relationship[] = [];
      const limit = resolveBatchSize();
      let offset = 0;
      while (true) {
        const batch = await repo.findByTypesPaged(CHANGE_RELATIONSHIP_TYPES, limit, offset);
        rels.push(...batch);
        if (batch.length < limit) break;
        offset += limit;
      }
      return rels;
    },
    lastCommitDate: (p) => new CommitRepository(pgPool, p).getLastCommitDate(p),
  });
}
