import { Entity, EntityType, Language, Relationship, RelationshipType } from '@repo-memory/shared';

export function makeEntity(
  overrides: Partial<Entity> & { name: string; stableId: string; filePath: string }
): Entity {
  return {
    id: overrides.stableId,
    type: EntityType.FUNCTION,
    language: Language.TYPESCRIPT,
    startLine: 1,
    endLine: 1,
    startColumn: 0,
    endColumn: 0,
    isExported: false,
    isTest: false,
    confidence: 0.9,
    createdAt: new Date('2026-01-01'),
    updatedAt: new Date('2026-01-01'),
    ...overrides,
  };
}

export function makeRel(
  overrides: Partial<Relationship> & {
    sourceId: string;
    targetId: string;
    type: RelationshipType;
    filePath: string;
  }
): Relationship {
  return {
    id: `${overrides.sourceId}:${overrides.targetId}:${overrides.type}`,
    line: 1,
    confidence: 0.9,
    createdAt: new Date('2026-01-01'),
    updatedAt: new Date('2026-01-01'),
    ...overrides,
  };
}
