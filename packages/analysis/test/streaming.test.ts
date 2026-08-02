import { describe, it, expect } from 'vitest';
import { streamDeadCode, streamBoundaries, forEachPage, resolveBatchSize } from '../src/streaming.js';
import type { PagedSource } from '../src/streaming.js';
import { detectDeadCode } from '../src/deadcode.js';
import { validateBoundaries } from '../src/boundaries.js';
import { parseDomainConfig } from '../src/domain.js';
import { makeEntity, makeRel } from './helpers.js';
import { EntityType, RelationshipType } from '@repo-memory/shared';

// Pages over an array in fixed windows so the streaming paths exercise the
// same short-page stopping logic as a real repo-backed source.
function arraySource<T>(items: T[]): PagedSource<T> {
  return { page: async (offset, limit) => items.slice(offset, offset + limit) };
}

function entity(name: string, filePath: string, opts: { exported?: boolean; type?: EntityType } = {}) {
  return makeEntity({
    name,
    filePath,
    stableId: `${filePath}:${name}`,
    type: opts.type ?? EntityType.FUNCTION,
    isExported: opts.exported ?? false,
  });
}

function fileEntity(filePath: string) {
  return makeEntity({ name: filePath.split('/').pop()!, filePath, stableId: filePath, type: EntityType.FILE });
}

describe('forEachPage', () => {
  it('iterates every row across windows and stops on a short page', async () => {
    const seen: string[] = [];
    const total = await forEachPage(arraySource(['a', 'b', 'c', 'd', 'e']), 2, async (rows) => {
      seen.push(...rows);
    });
    expect(seen).toEqual(['a', 'b', 'c', 'd', 'e']);
    expect(total).toBe(5);
  });

  it('returns zero for an empty source', async () => {
    const total = await forEachPage(arraySource<string>([]), 2, async () => {});
    expect(total).toBe(0);
  });
});

describe('resolveBatchSize', () => {
  it('defaults to 5000 and honors explicit values', () => {
    expect(resolveBatchSize()).toBe(5000);
    expect(resolveBatchSize(123)).toBe(123);
  });

  it('reads the ANALYSIS_BATCH_SIZE env knob', () => {
    const prev = process.env.ANALYSIS_BATCH_SIZE;
    process.env.ANALYSIS_BATCH_SIZE = '777';
    expect(resolveBatchSize()).toBe(777);
    expect(resolveBatchSize(10)).toBe(10);
    if (prev === undefined) delete process.env.ANALYSIS_BATCH_SIZE;
    else process.env.ANALYSIS_BATCH_SIZE = prev;
  });
});

describe('streamDeadCode (parity with detectDeadCode)', () => {
  it('flags the same dead entities as the in-memory version', async () => {
    const entry = entity('index', 'src/index.ts');
    const used = entity('used', 'src/a.ts');
    const alsoUsed = entity('alsoUsed', 'src/b.ts');
    const dead = entity('dead', 'src/c.ts');
    const exported = entity('publicApi', 'src/lib.ts', { exported: true });
    const rels = [
      makeRel({ sourceId: entry.stableId, targetId: used.stableId, type: RelationshipType.CALLS, filePath: 'src/index.ts' }),
      makeRel({ sourceId: used.stableId, targetId: alsoUsed.stableId, type: RelationshipType.IMPORTS, filePath: 'src/a.ts' }),
    ];
    const entities = [entry, used, alsoUsed, dead, exported];

    const inMemory = detectDeadCode(entities, rels);
    const streamed = await streamDeadCode(arraySource(entities), arraySource(rels), { batchSize: 2 });

    expect(streamed.totalEntities).toBe(inMemory.totalEntities);
    expect(streamed.deadCount).toBe(inMemory.deadCount);
    expect(streamed.deadCode.map(d => d.entity.stableId).sort()).toEqual(
      inMemory.deadCode.map(d => d.entity.stableId).sort()
    );
    expect(streamed.exportedButUnused.map(d => d.entity.stableId).sort()).toEqual(
      inMemory.exportedButUnused.map(d => d.entity.stableId).sort()
    );
  });

  it('produces identical reports regardless of batch size', async () => {
    const entities = [
      entity('index', 'src/index.ts'),
      entity('run', 'src/main.ts'),
      entity('unused', 'src/a.ts'),
      fileEntity('src/b.ts'),
      entity('cfg', 'package.json', { type: EntityType.CONFIG }),
      entity('testOne', 'src/a.test.ts', { type: EntityType.TEST }),
    ];
    const rels = [
      makeRel({ sourceId: 'src/index.ts:index', targetId: 'src/a.ts:unused', type: RelationshipType.CALLS, filePath: 'src/index.ts' }),
    ];

    const baseline = await streamDeadCode(arraySource(entities), arraySource(rels), { batchSize: 100 });
    for (const batchSize of [1, 2, 3, 4]) {
      const report = await streamDeadCode(arraySource(entities), arraySource(rels), { batchSize });
      expect(report).toEqual(baseline);
    }
  });
});

describe('streamBoundaries (parity with validateBoundaries)', () => {
  it('reports the same domains, edges, and violations as the in-memory version', async () => {
    const entities = [
      fileEntity('src/routes/a.ts'),
      entity('a', 'src/routes/a.ts'),
      fileEntity('src/models/b.ts'),
      fileEntity('src/services/c.ts'),
    ];
    const rels = [
      makeRel({ sourceId: 'src/routes/a.ts', targetId: 'src/models/b.ts', type: RelationshipType.IMPORTS, filePath: 'src/routes/a.ts' }),
      makeRel({ sourceId: 'src/routes/a.ts', targetId: 'src/services/c.ts', type: RelationshipType.REFERENCES, filePath: 'src/routes/a.ts' }),
    ];
    const config = parseDomainConfig(
      JSON.stringify({ domains: [], allowedCrossDomain: [{ from: '*', to: 'business' }], strict: false })
    );

    const inMemory = validateBoundaries(entities, rels, config);
    const streamed = await streamBoundaries(arraySource(entities), arraySource(rels), config, { batchSize: 2 });

    expect(streamed.strict).toBe(inMemory.strict);
    expect(streamed.domains).toEqual(inMemory.domains);
    expect(streamed.crossDomainEdges.length).toBe(inMemory.crossDomainEdges.length);
    expect(streamed.violations.length).toBe(inMemory.violations.length);
    expect(streamed.violations.map(v => v.relationshipType).sort()).toEqual(
      inMemory.violations.map(v => v.relationshipType).sort()
    );
  });

  it('produces identical reports regardless of batch size', async () => {
    const entities = [
      fileEntity('src/routes/a.ts'),
      fileEntity('src/models/b.ts'),
      fileEntity('src/models/c.ts'),
    ];
    const rels = [
      makeRel({ sourceId: 'src/routes/a.ts', targetId: 'src/models/b.ts', type: RelationshipType.IMPORTS, filePath: 'src/routes/a.ts' }),
      makeRel({ sourceId: 'src/models/c.ts', targetId: 'src/models/b.ts', type: RelationshipType.IMPORTS, filePath: 'src/models/c.ts' }),
    ];

    const baseline = await streamBoundaries(arraySource(entities), arraySource(rels), undefined, { batchSize: 100 });
    for (const batchSize of [1, 2, 3]) {
      const report = await streamBoundaries(arraySource(entities), arraySource(rels), undefined, { batchSize });
      expect(report).toEqual(baseline);
    }
  });

  it('ignores relationships whose endpoints are not real entities', async () => {
    const entities = [fileEntity('src/routes/a.ts'), fileEntity('src/models/b.ts')];
    const rels = [
      // Expression-text target that will never be a graph node
      makeRel({ sourceId: 'src/routes/a.ts', targetId: 'some.expression.text', type: RelationshipType.CALLS, filePath: 'src/routes/a.ts' }),
    ];
    const report = await streamBoundaries(arraySource(entities), arraySource(rels), undefined, { batchSize: 2 });
    expect(report.crossDomainEdges).toHaveLength(0);
  });
});
