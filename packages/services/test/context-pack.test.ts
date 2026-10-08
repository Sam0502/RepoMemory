import { describe, it, expect } from 'vitest';
import { ContextPackBuilder } from '../src/context-pack.js';
import { makeEntity } from '../../analysis/test/helpers.js';
import { EntityType } from '@repo-memory/shared';

function fnEntity(name: string, filePath: string, opts: { repoPath?: string; purpose?: string; signature?: string } = {}) {
  return makeEntity({
    name,
    filePath,
    stableId: `${filePath}:${name}`,
    type: EntityType.FUNCTION,
    repoPath: opts.repoPath,
    purpose: opts.purpose,
    signature: opts.signature,
  });
}

interface MockCommit {
  message: string;
  filesChanged: string[];
  repoPath?: string;
}

function makeBuilder(options: {
  entity?: ReturnType<typeof fnEntity>;
  deps?: ReturnType<typeof fnEntity>[];
  dependents?: ReturnType<typeof fnEntity>[];
  similar?: ReturnType<typeof fnEntity>[];
  commits?: MockCommit[];
} = {}) {
  const entityRepo = {
    findByStableId: async () => options.entity ?? null,
    findSimilar: async () => options.similar ?? [],
  };
  const commitRepo = {
    findRecent: async () =>
      (options.commits ?? []).map(c => ({
        hash: 'abc',
        message: c.message,
        author: 'dev',
        date: new Date(),
        repoPath: c.repoPath ?? '/repo',
        filesChanged: c.filesChanged,
      })),
  };
  const traversal = {
    findDependencies: async () => (options.deps ?? []).map(e => ({ entity: e, relationship: { type: 'CALLS' } })),
    findDependents: async () => (options.dependents ?? []).map(e => ({ entity: e, relationship: { type: 'CALLS' } })),
  };
  return new ContextPackBuilder(entityRepo as never, commitRepo as never, traversal as never);
}

describe('ContextPackBuilder', () => {
  it('builds a pack for a known entity', async () => {
    const target = fnEntity('createUser', 'src/api/users.ts');
    const builder = makeBuilder({ entity: target, deps: [fnEntity('helpers', 'src/lib/helpers.ts')] });
    const pack = await builder.build('s1');
    expect(pack?.entity.name).toBe('createUser');
    expect(pack?.dependencies).toHaveLength(1);
    expect(pack?.metadata.packageName).toBe('api');
    expect(pack?.tokenCount).toBeGreaterThan(0);
  });

  it('returns null for an unknown entity', async () => {
    const builder = makeBuilder({});
    expect(await builder.build('missing')).toBeNull();
  });

  it('trims to a token budget', async () => {
    const target = fnEntity('big', 'src/a.ts');
    const deps = Array.from({ length: 20 }, (_, i) =>
      fnEntity(`dep${i}`, 'src/deps.ts', { purpose: 'y'.repeat(1000), signature: 'x'.repeat(1000) })
    );
    const builder = makeBuilder({ entity: target, deps });
    const pack = await builder.build('s1', 1000);
    expect(pack!.tokenCount).toBeLessThanOrEqual(1000);
  });

  it('filters recent changes to the entity file', async () => {
    const target = fnEntity('createUser', 'src/api/users.ts', { repoPath: '/repo' });
    const builder = makeBuilder({
      entity: target,
      commits: [
        { message: 'touched it', filesChanged: ['src/api/users.ts'], repoPath: '/repo' },
        { message: 'other file', filesChanged: ['src/other.ts'], repoPath: '/repo' },
      ],
    });
    const pack = await builder.build('s1');
    expect(pack?.recentChanges.map(c => c.message)).toEqual(['touched it']);
  });
});
