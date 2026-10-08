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
  RelationshipType.HANDLES,
]);

const ENTRYPOINT_PATTERNS = /^(index|main|cli|server|app|entry|bootstrap|start|.*-server|.*-cli|.*-entry)$/i;

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
  const filePathToFileId = new Map<string, string>();
  for (const entity of entities) {
    entityByStableId.set(entity.stableId, entity);
    if (entity.type === EntityType.FILE) filePathToFileId.set(entity.filePath, entity.stableId);
  }

  const resolveSource = (id: string): string | null => {
    if (entityByStableId.has(id)) return id;
    // Pre-reanchor rows use the raw file path as IMPORTS/EXPORTS sourceId.
    const fileId = filePathToFileId.get(id);
    if (fileId) return fileId;
    return null;
  };

  // Build outgoing adjacency over edges between real entities
  const outgoing = new Map<string, Array<{ target: string; type: RelationshipType }>>();
  for (const rel of relationships) {
    if (!RELEVANT_TYPES.has(rel.type)) continue;
    const source = resolveSource(rel.sourceId);
    if (!source || !entityByStableId.has(rel.targetId)) continue;
    const list = outgoing.get(source);
    if (list) list.push({ target: rel.targetId, type: rel.type });
    else outgoing.set(source, [{ target: rel.targetId, type: rel.type }]);
  }

  // Determine roots: entrypoint files/functions + test files + test entities
  const roots = new Set<string>();
  for (const entity of entities) {
    if (isDeadCodeRoot(entity)) roots.add(entity.stableId);
  }

  // BFS from roots over outgoing edges (an entity is reachable only if a reachable source references it)
  const reachable = new Set<string>(roots);
  const queue = [...roots];
  let head = 0;
  while (head < queue.length) {
    const current = queue[head++]!;
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
