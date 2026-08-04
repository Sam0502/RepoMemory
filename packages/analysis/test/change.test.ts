import { describe, it, expect } from 'vitest';
import { ChangeAnalyzer, ChangeDataProvider } from '../src/change.js';
import { makeEntity, makeRel } from './helpers.js';
import { Entity, FileChurnRow, RelationshipType } from '@repo-memory/shared';

const NOW = new Date('2026-08-02');

function churnRow(filePath: string, commits: number, additions: number, deletions: number, daysAgo: number): FileChurnRow {
  return {
    filePath,
    commits,
    additions,
    deletions,
    lastChanged: new Date(NOW.getTime() - daysAgo * 86400000),
  };
}

function makeProvider(overrides: Partial<ChangeDataProvider> = {}): ChangeDataProvider {
  return {
    fileChurnRows: async () => [],
    entities: async () => [],
    relationships: async () => [],
    lastCommitDate: async () => null,
    ...overrides,
  };
}

describe('ChangeAnalyzer.computeFileChurn', () => {
  it('sorts by churn score (adds + 2*deletes) and limits', async () => {
    const provider = makeProvider({
      fileChurnRows: async () => [
        churnRow('a.ts', 5, 100, 10, 10),
        churnRow('b.ts', 2, 10, 50, 1),
        churnRow('c.ts', 1, 1, 1, 1),
      ],
    });
    const analyzer = new ChangeAnalyzer(provider);
    const churn = await analyzer.computeFileChurn('/repo', 2);
    expect(churn).toHaveLength(2);
    expect(churn[0].filePath).toBe('a.ts'); // 100 + 2*10 = 120
    expect(churn[1].filePath).toBe('b.ts'); // 10 + 2*50 = 110
    expect(churn[0].churnScore).toBe(120);
  });

  it('computes daysSinceLastChange', async () => {
    const provider = makeProvider({
      fileChurnRows: async () => [churnRow('a.ts', 1, 0, 0, 3)],
    });
    const analyzer = new ChangeAnalyzer(provider);
    const [row] = await analyzer.computeFileChurn('/repo', 50, undefined, NOW);
    expect(row.daysSinceLastChange).toBe(3);
  });
});

describe('ChangeAnalyzer.computeEntityChange', () => {
  it('returns null for an unknown entity', async () => {
    const analyzer = new ChangeAnalyzer(makeProvider());
    expect(await analyzer.computeEntityChange('/repo', 'missing')).toBeNull();
  });

  it('attaches owning-file churn and commit lineage', async () => {
    const entity: Entity = makeEntity({
      name: 'foo',
      stableId: 's1',
      filePath: 'src/a.ts',
      firstSeenCommit: 'c1',
      lastSeenCommit: 'c2',
    });
    const provider = makeProvider({
      entities: async () => [entity],
      fileChurnRows: async () => [churnRow('src/a.ts', 7, 50, 5, 2)],
    });
    const analyzer = new ChangeAnalyzer(provider);
    const info = await analyzer.computeEntityChange('/repo', 's1');
    expect(info?.commitCount).toBe(7);
    expect(info?.firstSeenCommit).toBe('c1');
    expect(info?.lastSeenCommit).toBe('c2');
    expect(info?.owningFileChurn?.filePath).toBe('src/a.ts');
  });
});

describe('ChangeAnalyzer.computeFileRisk', () => {
  it('produces a bounded score with an explainable breakdown', async () => {
    const entry = makeEntity({ name: 'index', stableId: 'e1', filePath: 'src/index.ts' });
    const highChurn = makeEntity({ name: 'hot', stableId: 'e2', filePath: 'src/hot.ts' });
    const rels = [
      makeRel({
        sourceId: entry.stableId,
        targetId: highChurn.stableId,
        type: RelationshipType.CALLS,
        filePath: 'src/index.ts',
      }),
    ];
    const provider = makeProvider({
      fileChurnRows: async () => [churnRow('src/hot.ts', 10, 1000, 0, 1), churnRow('src/index.ts', 1, 1, 0, 1)],
      entities: async () => [entry, highChurn],
      relationships: async () => rels,
    });
    const analyzer = new ChangeAnalyzer(provider);
    const risks = await analyzer.computeFileRisk('/repo');
    expect(risks.length).toBe(2);
    const hot = risks.find(r => r.filePath === 'src/hot.ts')!;
    expect(hot.score).toBeGreaterThanOrEqual(0);
    expect(hot.score).toBeLessThanOrEqual(100);
    expect(hot.breakdown.churn).toBe(100);
    expect(hot.breakdown.fanout).toBe(10); // 1 inbound dependent × 10
  });

  it('returns identical results via a paged provider (streaming path)', async () => {
    const entities = [
      makeEntity({ name: 'index', stableId: 'e1', filePath: 'src/index.ts' }),
      makeEntity({ name: 'hot', stableId: 'e2', filePath: 'src/hot.ts' }),
    ];
    const rels = [
      makeRel({ sourceId: 'e1', targetId: 'e2', type: RelationshipType.CALLS, filePath: 'src/index.ts' }),
    ];
    const rows = [churnRow('src/hot.ts', 10, 1000, 0, 1), churnRow('src/index.ts', 1, 1, 0, 1)];

    const arrayProvider = makeProvider({
      fileChurnRows: async () => rows,
      entities: async () => entities,
      relationships: async () => rels,
    });
    const arrayRisks = await new ChangeAnalyzer(arrayProvider).computeFileRisk('/repo');

    const pagedProvider = makeProvider({
      fileChurnRows: async () => rows,
      entityPage: async (_p, offset, limit) => entities.slice(offset, offset + limit),
      relationshipPage: async (_p, offset, limit) => rels.slice(offset, offset + limit),
    });
    const pagedRisks = await new ChangeAnalyzer(pagedProvider).computeFileRisk('/repo');

    expect(pagedRisks).toEqual(arrayRisks);
  });
});

describe('ChangeAnalyzer.detectDrift', () => {
  it('flags unstable public surfaces on high-commit exported files', async () => {
    const exported = makeEntity({ name: 'api', stableId: 's1', filePath: 'src/api.ts', isExported: true });
    const provider = makeProvider({
      fileChurnRows: async (_, days) =>
        days ? [] : [churnRow('src/api.ts', 10, 100, 0, 1)],
      entities: async () => [exported],
      relationships: async () => [],
    });
    const analyzer = new ChangeAnalyzer(provider);
    const report = await analyzer.detectDrift('/repo');
    expect(report.signals.some(s => s.type === 'unstable-public-surface')).toBe(true);
  });

  it('returns no signals for a stable repo', async () => {
    const provider = makeProvider({
      fileChurnRows: async () => [],
      entities: async () => [],
      relationships: async () => [],
    });
    const analyzer = new ChangeAnalyzer(provider);
    const report = await analyzer.detectDrift('/repo');
    expect(report.signals).toHaveLength(0);
  });
});
