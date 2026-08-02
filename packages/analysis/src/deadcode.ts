import { Entity, Relationship, RelationshipType, EntityType, Language } from '@repo-memory/shared';

export interface DeadCodeItem {
  entity: Entity;
  reason: string;
}

export interface DeadCodeReport {
  deadCode: DeadCodeItem[];
  exportedButUnused: DeadCodeItem[];
  totalEntities: number;
  deadCount: number;
}

export const RELEVANT_TYPES: ReadonlySet<RelationshipType> = new Set([
  RelationshipType.CALLS,
  RelationshipType.REFERENCES,
  RelationshipType.IMPORTS,
  RelationshipType.EXTENDS,
  RelationshipType.IMPLEMENTS,
]);

const ENTRYPOINT_PATTERNS = /^(index|main|cli|server|app|entry|bootstrap|start)$/i;

// True when an entity is a reachability root: entrypoint files/functions,
// test files, test entities, or entrypoint-named symbols.
export function isDeadCodeRoot(entity: Entity): boolean {
  if (entity.type === EntityType.FILE) {
    const fileBase = (entity.filePath.split(/[\\/]/).pop() || '').replace(/\.[^.]+$/, '').toLowerCase();
    return ENTRYPOINT_PATTERNS.test(fileBase);
  }
  if (entity.isTest || entity.type === EntityType.TEST || entity.type === EntityType.TEST_SUITE) {
    return true;
  }
  return ENTRYPOINT_PATTERNS.test(entity.name);
}

// Detects dead code via reachability analysis from entrypoint and test roots over
// resolved relationship edges. Requires symbol-resolved relationships (see resolver)
// to avoid over-reporting on unresolved bare names.
export function detectDeadCode(entities: Entity[], relationships: Relationship[]): DeadCodeReport {
  const entityByStableId = new Map<string, Entity>();
  for (const entity of entities) entityByStableId.set(entity.stableId, entity);

  // Build outgoing adjacency over edges between real entities
  const outgoing = new Map<string, Array<{ target: string; type: RelationshipType }>>();
  for (const rel of relationships) {
    if (!RELEVANT_TYPES.has(rel.type)) continue;
    if (!entityByStableId.has(rel.sourceId) || !entityByStableId.has(rel.targetId)) continue;
    const list = outgoing.get(rel.sourceId);
    if (list) list.push({ target: rel.targetId, type: rel.type });
    else outgoing.set(rel.sourceId, [{ target: rel.targetId, type: rel.type }]);
  }

  // Determine roots: entrypoint files/functions + test files + test entities
  const roots = new Set<string>();
  for (const entity of entities) {
    if (isDeadCodeRoot(entity)) roots.add(entity.stableId);
  }

  // BFS from roots over outgoing edges (an entity is reachable only if a reachable source references it)
  const reachable = new Set<string>(roots);
  const queue = [...roots];
  while (queue.length > 0) {
    const current = queue.shift()!;
    for (const edge of outgoing.get(current) || []) {
      if (!reachable.has(edge.target)) {
        reachable.add(edge.target);
        queue.push(edge.target);
      }
    }
  }

  const deadCode: DeadCodeItem[] = [];
  const exportedButUnused: DeadCodeItem[] = [];

  for (const entity of entities) {
    if (reachable.has(entity.stableId)) continue;
    if (entity.type === EntityType.FILE || entity.type === EntityType.CONFIG) continue;
    if (entity.language === Language.UNKNOWN) continue;

    if (entity.isExported) {
      exportedButUnused.push({ entity, reason: 'exported but never referenced from a reachable root' });
    } else {
      deadCode.push({ entity, reason: 'never referenced from an entrypoint or test root' });
    }
  }

  return {
    deadCode,
    exportedButUnused,
    totalEntities: entities.length,
    deadCount: deadCode.length,
  };
}
