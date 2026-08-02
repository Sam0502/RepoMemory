import { describe, it, expect } from 'vitest';
import { SymbolIndex } from '../src/resolver/symbol-index.js';
import { makeEntity, makeRel } from './helpers.js';
import { EntityType, RelationshipType } from '@repo-memory/shared';

function entity(name: string, filePath: string, opts: { exported?: boolean } = {}) {
  return makeEntity({
    name,
    filePath,
    stableId: `${filePath}:${name}`,
    type: EntityType.FUNCTION,
    isExported: opts.exported ?? false,
  });
}

describe('SymbolIndex.lookup', () => {
  it('prefers a same-file definition', () => {
    const index = new SymbolIndex('/repo');
    index.addEntities([entity('helper', 'src/a.ts'), entity('helper', 'src/b.ts', { exported: true })]);
    const result = index.lookup('helper', 'src/a.ts');
    expect(result?.hint).toBe('same-file');
    expect(result?.definition.filePath).toBe('src/a.ts');
  });

  it('resolves through an imported symbol via the import map', () => {
    const index = new SymbolIndex('/repo');
    index.addEntities([
      entity('helper', 'src/b.ts', { exported: true }),
      entity('main', 'src/a.ts'),
    ]);
    index.addFile('src/b.ts');
    index.addFile('src/a.ts');
    index.registerRelationships([
      makeRel({
        sourceId: 'src/a.ts',
        targetId: 'helper',
        type: RelationshipType.IMPORTS,
        filePath: 'src/a.ts',
        metadata: { importPath: './b' },
      }),
    ]);
    const result = index.lookup('helper', 'src/a.ts');
    expect(result?.hint).toBe('import');
    expect(result?.definition.filePath).toBe('src/b.ts');
  });

  it('resolves a globally-unique name', () => {
    const index = new SymbolIndex('/repo');
    index.addEntities([entity('unique', 'src/b.ts')]);
    const result = index.lookup('unique', 'src/a.ts');
    expect(result?.hint).toBe('global-unique');
    expect(result?.confidence).toBe(0.8);
  });

  it('picks the exported definition when ambiguous', () => {
    const index = new SymbolIndex('/repo');
    index.addEntities([
      entity('dup', 'src/b.ts', { exported: true }),
      entity('dup', 'src/c.ts'),
    ]);
    const result = index.lookup('dup', 'src/a.ts');
    expect(result?.hint).toBe('ambiguous');
    expect(result?.definition.filePath).toBe('src/b.ts');
  });

  it('returns null when nothing matches', () => {
    const index = new SymbolIndex('/repo');
    index.addEntities([entity('helper', 'src/b.ts')]);
    expect(index.lookup('missing', 'src/a.ts')).toBeNull();
  });

  it('deduplicates entities with the same stableId', () => {
    const index = new SymbolIndex('/repo');
    const e = entity('helper', 'src/b.ts');
    index.addEntity(e);
    index.addEntity({ ...e });
    expect(index.definitionsByName('helper')).toHaveLength(1);
  });
});
