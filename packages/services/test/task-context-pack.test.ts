import { describe, it, expect } from 'vitest';
import { ContextPackBuilder } from '../src/context-pack.js';
import { makeEntity, makeRel } from '../../analysis/test/helpers.js';
import { EntityType, RelationshipType } from '@repo-memory/shared';
import type { Commit } from '@repo-memory/shared';

function fnEntity(
  name: string,
  filePath: string,
  opts: { repoPath?: string; purpose?: string; signature?: string; domain?: string } = {}
) {
  return makeEntity({
    name,
    filePath,
    stableId: `${filePath}:${name}`,
    type: EntityType.FUNCTION,
    repoPath: opts.repoPath ?? '/repo',
    purpose: opts.purpose,
    signature: opts.signature,
    domain: opts.domain,
  });
}

interface TaskMocks {
  direct?: ReturnType<typeof fnEntity> | null;
  filePathEntities?: ReturnType<typeof fnEntity>[];
  search?: ReturnType<typeof fnEntity>[];
  semantic?: ReturnType<typeof fnEntity>[];
  embedVector?: number[];
  deps?: ReturnType<typeof fnEntity>[];
  dependents?: ReturnType<typeof fnEntity>[];
  commits?: Commit[];
  churn?: Array<{ filePath: string; commits: number; additions: number; deletions: number; lastChanged: Date }>;
}

function makeTaskBuilder(mocks: TaskMocks = {}) {
  const entityRepo = {
    findByStableId: async () => (mocks.direct !== undefined ? mocks.direct : null),
    findByFilePath: async () => mocks.filePathEntities ?? [],
    search: async () => mocks.search ?? [],
    findByEmbedding: async () => mocks.semantic ?? [],
    findAll: async () => [],
  };
  const commitRepo = {
    findCommitsForFile: async () => mocks.commits ?? [],
  };
  const traversal = {
    findDependencies: async () =>
      (mocks.deps ?? []).map(e => ({
        entity: e,
        relationship: makeRel({
          sourceId: 'x',
          targetId: e.stableId,
          type: RelationshipType.CALLS,
          filePath: 'src/a.ts',
        }),
      })),
    findDependents: async () =>
      (mocks.dependents ?? []).map(e => ({
        entity: e,
        relationship: makeRel({
          sourceId: 'x',
          targetId: e.stableId,
          type: RelationshipType.CALLS,
          filePath: 'src/a.ts',
        }),
      })),
  };
  const options = {
    repoPath: '/repo',
    embedder: mocks.embedVector ? { embed: async () => mocks.embedVector } : undefined,
    changeAnalyzer: mocks.churn
      ? {
          computeFileChurn: async () =>
            mocks.churn!.map(row => ({
              ...row,
              churnScore: row.additions + 2 * row.deletions,
              daysSinceLastChange: 0,
            })),
        }
      : undefined,
  };
  return new ContextPackBuilder(entityRepo as never, commitRepo as never, traversal as never, options as never);
}

function commit(message: string, filePath: string, date = new Date()): Commit {
  return { hash: 'h', repoPath: '/repo', message, author: 'dev', date, filesChanged: [filePath] };
}

describe('ContextPackBuilder.buildTaskContext', () => {
  it('seeds by keyword and builds a task pack', async () => {
    const builder = makeTaskBuilder({
      search: [
        fnEntity('createUser', 'src/api/users.ts'),
        fnEntity('userModel', 'src/models/user.ts', { domain: 'data' }),
      ],
    });
    const pack = await builder.buildTaskContext('create user');
    expect(pack).not.toBeNull();
    expect(pack!.focalEntities).toHaveLength(2);
    expect(pack!.metadata.rankingStrategy).toBe('keyword');
    expect(pack!.files.map(f => f.filePath)).toEqual(['src/api/users.ts', 'src/models/user.ts']);
    expect(pack!.boundaries.domains).toContain('data');
    expect(pack!.tokenCount).toBeGreaterThan(0);
  });

  it('returns null when nothing matches', async () => {
    const builder = makeTaskBuilder({});
    expect(await builder.buildTaskContext('zzz no match zzz')).toBeNull();
  });

  it('resolves a stable ID directly as the single focal entity', async () => {
    const direct = fnEntity('createUser', 'src/api/users.ts');
    const builder = makeTaskBuilder({ direct });
    const pack = await builder.buildTaskContext('src/api/users.ts:createUser');
    expect(pack!.focalEntities.map(e => e.stableId)).toEqual([direct.stableId]);
  });

  it('uses semantic seeding when an embedder is present', async () => {
    const semantic = fnEntity('parseCommand', 'src/commands.ts');
    const builder = makeTaskBuilder({ embedVector: [0.1, 0.2], semantic: [semantic] });
    const pack = await builder.buildTaskContext('handle command input');
    expect(pack!.focalEntities.map(e => e.stableId)).toEqual([semantic.stableId]);
    expect(pack!.metadata.rankingStrategy).toBe('keyword+semantic');
  });

  it('expands one graph hop and collects relationships + commits', async () => {
    const builder = makeTaskBuilder({
      search: [fnEntity('createUser', 'src/api/users.ts')],
      deps: [fnEntity('dbHelper', 'src/lib/db.ts')],
      dependents: [fnEntity('userController', 'src/controllers/user.ts')],
      commits: [commit('add user endpoint', 'src/api/users.ts')],
    });
    const pack = await builder.buildTaskContext('user endpoint');
    expect(pack!.relationships.length).toBeGreaterThan(0);
    expect(pack!.recentChanges.map(c => c.message)).toEqual(['add user endpoint']);
  });

  it('attaches per-file risk from the change analyzer', async () => {
    const builder = makeTaskBuilder({
      search: [fnEntity('hot', 'src/hot.ts')],
      churn: [
        {
          filePath: 'src/hot.ts',
          commits: 12,
          additions: 300,
          deletions: 40,
          lastChanged: new Date(),
        },
      ],
    });
    const pack = await builder.buildTaskContext('hot code');
    const riskFile = pack!.risk.files.find(f => f.filePath === 'src/hot.ts');
    expect(riskFile?.commitCount).toBe(12);
    expect(riskFile!.riskScore).toBeGreaterThan(0);
  });

  it('trims to a token budget', async () => {
    const many = Array.from({ length: 10 }, (_, i) =>
      fnEntity(`big${i}`, `src/big${i}.ts`, { purpose: 'x'.repeat(600), signature: 'y'.repeat(600) })
    );
    const builder = makeTaskBuilder({ search: many });
    const pack = await builder.buildTaskContext('big functions', { tokenBudget: 800 });
    expect(pack).not.toBeNull();
    expect(pack!.tokenCount).toBeLessThanOrEqual(800);
    expect(pack!.focalEntities.length).toBeLessThan(many.length);
  });
});
