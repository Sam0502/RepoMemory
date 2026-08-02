import { describe, it, expect } from 'vitest';
import { detectDeadCode } from '../src/deadcode.js';
import { makeEntity, makeRel } from './helpers.js';
import { EntityType, RelationshipType } from '@repo-memory/shared';

function entity(name: string, filePath: string, opts: { exported?: boolean; type?: EntityType } = {}) {
  return makeEntity({
    name,
    filePath,
    stableId: `${filePath}:${name}`,
    type: opts.type ?? EntityType.FUNCTION,
    isExported: opts.exported ?? false,
  });
}

describe('detectDeadCode', () => {
  it('flags a non-exported function with no inbound edges', () => {
    const entry = entity('index', 'src/index.ts');
    const unused = entity('unused', 'src/a.ts');
    const report = detectDeadCode([entry, unused], []);
    expect(report.deadCode.map(d => d.entity.stableId)).toContain(unused.stableId);
    expect(report.deadCode.map(d => d.entity.stableId)).not.toContain(entry.stableId);
  });

  it('treats entrypoint files and test entities as reachable roots', () => {
    const main = entity('main', 'src/main.ts');
    const dead = entity('unused', 'src/a.ts');
    const testFn = entity('test_one', 'src/a.test.ts', { type: EntityType.TEST });
    const report = detectDeadCode([main, dead, testFn], []);
    expect(report.deadCode).toHaveLength(1);
    expect(report.deadCode[0].entity.stableId).toBe(dead.stableId);
  });

  it('propagates reachability through resolved edges', () => {
    const entry = entity('index', 'src/index.ts');
    const used = entity('used', 'src/a.ts');
    const alsoUsed = entity('alsoUsed', 'src/b.ts');
    const dead = entity('dead', 'src/c.ts');
    const rels = [
      makeRel({
        sourceId: entry.stableId,
        targetId: used.stableId,
        type: RelationshipType.CALLS,
        filePath: 'src/index.ts',
      }),
      makeRel({
        sourceId: used.stableId,
        targetId: alsoUsed.stableId,
        type: RelationshipType.IMPORTS,
        filePath: 'src/a.ts',
      }),
    ];
    const report = detectDeadCode([entry, used, alsoUsed, dead], rels);
    const deadIds = report.deadCode.map(d => d.entity.stableId);
    expect(deadIds).toContain(dead.stableId);
    expect(deadIds).not.toContain(used.stableId);
    expect(deadIds).not.toContain(alsoUsed.stableId);
  });

  it('splits exported-but-unused symbols into a separate bucket', () => {
    const entry = entity('index', 'src/index.ts');
    const exported = entity('publicApi', 'src/lib.ts', { exported: true });
    const report = detectDeadCode([entry, exported], []);
    expect(report.exportedButUnused.map(d => d.entity.stableId)).toContain(exported.stableId);
    expect(report.deadCode).toHaveLength(0);
  });

  it('ignores File and Config entities', () => {
    const entry = entity('index', 'src/index.ts');
    const file = entity('a.ts', 'src/a.ts', { type: EntityType.FILE });
    const config = entity('package', 'package.json', { type: EntityType.CONFIG });
    const report = detectDeadCode([entry, file, config], []);
    expect(report.deadCode).toHaveLength(0);
  });

  it('reports totals', () => {
    const entry = entity('index', 'src/index.ts');
    const dead = entity('dead', 'src/a.ts');
    const report = detectDeadCode([entry, dead], []);
    expect(report.totalEntities).toBe(2);
    expect(report.deadCount).toBe(1);
  });
});
