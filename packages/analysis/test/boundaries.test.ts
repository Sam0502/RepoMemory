import { describe, it, expect } from 'vitest';
import { validateBoundaries } from '../src/boundaries.js';
import { parseDomainConfig } from '../src/domain.js';
import { makeEntity, makeRel } from './helpers.js';
import { EntityType, RelationshipType } from '@repo-memory/shared';

function fileEntity(filePath: string) {
  return makeEntity({ name: filePath.split('/').pop()!, filePath, stableId: filePath, type: EntityType.FILE });
}

function fnEntity(filePath: string, name: string) {
  return makeEntity({ name, filePath, stableId: `${filePath}:${name}`, type: EntityType.FUNCTION });
}

describe('validateBoundaries', () => {
  it('reports cross-domain import edges', () => {
    const entities = [fileEntity('src/routes/a.ts'), fileEntity('src/models/b.ts')];
    const rels = [
      makeRel({
        sourceId: 'src/routes/a.ts',
        targetId: 'src/models/b.ts',
        type: RelationshipType.IMPORTS,
        filePath: 'src/routes/a.ts',
      }),
    ];
    const report = validateBoundaries(entities, rels);
    expect(report.crossDomainEdges).toHaveLength(1);
    expect(report.crossDomainEdges[0].source.domain).toBe('web');
    expect(report.crossDomainEdges[0].target.domain).toBe('data');
  });

  it('flags only IMPORTS in non-strict mode', () => {
    const entities = [fileEntity('src/routes/a.ts'), fileEntity('src/models/b.ts')];
    const rels = [
      makeRel({
        sourceId: 'src/routes/a.ts',
        targetId: 'src/models/b.ts',
        type: RelationshipType.IMPORTS,
        filePath: 'src/routes/a.ts',
      }),
      makeRel({
        sourceId: 'src/routes/a.ts',
        targetId: 'src/models/b.ts',
        type: RelationshipType.REFERENCES,
        filePath: 'src/routes/a.ts',
      }),
    ];
    const report = validateBoundaries(entities, rels);
    expect(report.violations).toHaveLength(1);
    expect(report.violations[0].relationshipType).toBe(RelationshipType.IMPORTS);
  });

  it('flags all disallowed edges in strict mode', () => {
    const entities = [fileEntity('src/routes/a.ts'), fileEntity('src/models/b.ts')];
    const rels = [
      makeRel({
        sourceId: 'src/routes/a.ts',
        targetId: 'src/models/b.ts',
        type: RelationshipType.REFERENCES,
        filePath: 'src/routes/a.ts',
      }),
    ];
    const config = parseDomainConfig(JSON.stringify({ strict: true, domains: [], allowedCrossDomain: [] }));
    const report = validateBoundaries(entities, rels, config);
    expect(report.violations).toHaveLength(1);
    expect(report.strict).toBe(true);
  });

  it('respects allowedCrossDomain rules and wildcards', () => {
    const entities = [fileEntity('src/routes/a.ts'), fileEntity('src/models/b.ts'), fileEntity('src/services/c.ts')];
    const rels = [
      makeRel({
        sourceId: 'src/routes/a.ts',
        targetId: 'src/models/b.ts',
        type: RelationshipType.IMPORTS,
        filePath: 'src/routes/a.ts',
      }),
      makeRel({
        sourceId: 'src/routes/a.ts',
        targetId: 'src/services/c.ts',
        type: RelationshipType.IMPORTS,
        filePath: 'src/routes/a.ts',
      }),
    ];
    const config = parseDomainConfig(
      JSON.stringify({
        domains: [],
        allowedCrossDomain: [
          { from: 'web', to: 'data' },
          { from: '*', to: 'business' },
        ],
      })
    );
    const report = validateBoundaries(entities, rels, config);
    expect(report.violations).toHaveLength(0);
  });

  it('ignores same-domain edges', () => {
    const entities = [fileEntity('src/models/a.ts'), fileEntity('src/models/b.ts')];
    const rels = [
      makeRel({
        sourceId: 'src/models/a.ts',
        targetId: 'src/models/b.ts',
        type: RelationshipType.IMPORTS,
        filePath: 'src/models/a.ts',
      }),
    ];
    const report = validateBoundaries(entities, rels);
    expect(report.crossDomainEdges).toHaveLength(0);
    expect(report.violations).toHaveLength(0);
  });

  it('builds a domain summary with file and entity counts', () => {
    const entities = [fileEntity('src/routes/a.ts'), fnEntity('src/routes/a.ts', 'a'), fileEntity('src/models/b.ts')];
    const report = validateBoundaries(entities, []);
    const web = report.domains.find(d => d.name === 'web');
    expect(web?.entityCount).toBe(2);
    expect(web?.fileCount).toBe(1);
  });
});
