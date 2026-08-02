import { describe, it, expect } from 'vitest';
import { SymbolIndex } from '../src/resolver/symbol-index.js';
import { RelationshipResolver } from '../src/resolver/resolve.js';
import { generateFileStableId } from '../src/resolver/ids.js';
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

function buildResolver(entities: ReturnType<typeof entity>[], relationships: ReturnType<typeof makeRel>[]) {
  const index = new SymbolIndex('/repo');
  index.addEntities(entities);
  for (const e of entities) index.addFile(e.filePath);
  index.registerRelationships(relationships);
  return new RelationshipResolver(index, '/repo');
}

describe('RelationshipResolver', () => {
  it('resolves a CALLS bare-name target to the real stable ID', () => {
    const callee = entity('helper', 'src/b.ts');
    const caller = entity('main', 'src/a.ts');
    const rel = makeRel({
      sourceId: caller.stableId,
      targetId: 'helper',
      type: RelationshipType.CALLS,
      filePath: 'src/a.ts',
    });
    const resolver = buildResolver([callee, caller], [rel]);
    const [resolved] = resolver.resolveRelationships([rel]);
    expect(resolved.targetId).toBe(callee.stableId);
    expect(resolved.metadata?.resolvedBy).toBe('symbol-index');
    expect(resolved.metadata?.resolutionHint).toContain('global-unique');
  });

  it('resolves this.member to the member name', () => {
    const method = entity('render', 'src/a.ts');
    const owner = entity('Class', 'src/a.ts');
    const rel = makeRel({
      sourceId: owner.stableId,
      targetId: 'this.render',
      type: RelationshipType.CALLS,
      filePath: 'src/a.ts',
    });
    const resolver = buildResolver([method, owner], [rel]);
    const [resolved] = resolver.resolveRelationships([rel]);
    expect(resolved.targetId).toBe(method.stableId);
    expect(resolved.metadata?.resolutionHint).toContain('this-member');
  });

  it('marks unresolved targets with confidence 0.3 and provenance', () => {
    const caller = entity('main', 'src/a.ts');
    const rel = makeRel({
      sourceId: caller.stableId,
      targetId: 'missing',
      type: RelationshipType.CALLS,
      filePath: 'src/a.ts',
    });
    const resolver = buildResolver([caller], [rel]);
    const [resolved] = resolver.resolveRelationships([rel]);
    expect(resolved.confidence).toBeLessThanOrEqual(0.3);
    expect(resolved.metadata?.unresolvedTarget).toBe('missing');
  });

  it('passes through targets that are already real stable IDs', () => {
    const callee = entity('helper', 'src/b.ts');
    const caller = entity('main', 'src/a.ts');
    const rel = makeRel({
      sourceId: caller.stableId,
      targetId: callee.stableId,
      type: RelationshipType.CALLS,
      filePath: 'src/a.ts',
    });
    const resolver = buildResolver([callee, caller], [rel]);
    const [resolved] = resolver.resolveRelationships([rel]);
    expect(resolved.targetId).toBe(callee.stableId);
    expect(resolved.metadata?.resolutionHint).toBe('already-resolved');
  });

  it('re-anchors symbol-import sources to the file entity', () => {
    const helper = entity('helper', 'src/b.ts', { exported: true });
    const rel = makeRel({
      sourceId: 'src/a.ts',
      targetId: 'helper',
      type: RelationshipType.IMPORTS,
      filePath: 'src/a.ts',
      metadata: { importPath: './b' },
    });
    const resolver = buildResolver([helper], [rel]);
    const [resolved] = resolver.resolveRelationships([rel]);
    expect(resolved.sourceId).toBe(generateFileStableId('/repo', 'src/a.ts'));
    expect(resolved.targetId).toBe(helper.stableId);
  });

  it('leaves module-level imports untouched', () => {
    const rel = makeRel({
      sourceId: 'src/a.ts',
      targetId: 'src/b.ts',
      type: RelationshipType.IMPORTS,
      filePath: 'src/a.ts',
    });
    const resolver = buildResolver([], [rel]);
    const [resolved] = resolver.resolveRelationships([rel]);
    expect(resolved.sourceId).toBe('src/a.ts');
    expect(resolved.targetId).toBe('src/b.ts');
  });
});
