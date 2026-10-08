import { Entity, Relationship, RelationshipType, EntityType, Language } from '@repo-memory/shared';
import { DeadCodeReport, DeadCodeItem, RELEVANT_TYPES, isDeadCodeRoot } from './deadcode.js';
import { BoundaryReport, BoundaryViolation, DomainSummary } from './boundaries.js';
import { DomainConfig, inferDomain } from './domain.js';

export const DEFAULT_BATCH_SIZE = 5000;

// Bounded window size for streaming analysis. Reading pages of this many rows
// keeps peak memory O(working-set) rather than O(repo). Exposed as an env knob
// so deployments can tune it without code changes.
export function resolveBatchSize(explicit?: number): number {
  if (explicit && explicit > 0) return explicit;
  const env = Number.parseInt(process.env.ANALYSIS_BATCH_SIZE || '', 10);
  if (Number.isFinite(env) && env > 0) return env;
  return DEFAULT_BATCH_SIZE;
}

// Paged data access contract. Implementors (repos, arrays, fixtures) page over
// the underlying store in stable windows (ORDER BY a deterministic key) so the
// analysis can stop pulling once a short page signals the end.
export interface PagedSource<T> {
  page(offset: number, limit: number): Promise<T[]>;
}

export interface StreamOptions {
  batchSize?: number;
}

// Streams a full dataset through a callback in windows, stopping on a short
// page (the standard paging-end signal). Returns the number of rows seen.
export async function forEachPage<T>(
  source: PagedSource<T>,
  batchSize: number,
  fn: (rows: T[], offset: number) => void | Promise<void>
): Promise<number> {
  let offset = 0;
  let total = 0;
  while (true) {
    const rows = await source.page(offset, batchSize);
    if (rows.length === 0) break;
    await fn(rows, offset);
    total += rows.length;
    if (rows.length < batchSize) break;
    offset += batchSize;
  }
  return total;
}

// --- Dead code (streaming) -------------------------------------------------

// Compact entity metadata needed for dead-code classification. Deliberately not
// the full Entity shape: signatures/docstrings/purpose strings are dropped so
// the in-memory working set stays small regardless of repo size.
interface CompactEntity {
  type: EntityType;
  language: Language;
  isExported: boolean;
  isTest: boolean;
  name: string;
  filePath: string;
}

export async function streamDeadCode(
  entities: PagedSource<Entity>,
  relationships: PagedSource<Relationship>,
  opts: StreamOptions = {}
): Promise<DeadCodeReport> {
  const batchSize = resolveBatchSize(opts.batchSize);

  // Pass 1: stream entities into a compact index + root set. Keep only the
  // fields classification needs; drop heavy doc/signature strings.
  const index = new Map<string, CompactEntity>();
  const filePathToFileId = new Map<string, string>();
  const roots = new Set<string>();
  let totalEntities = 0;
  await forEachPage(entities, batchSize, (rows) => {
    for (const entity of rows) {
      totalEntities++;
      index.set(entity.stableId, {
        type: entity.type,
        language: entity.language,
        isExported: entity.isExported,
        isTest: entity.isTest,
        name: entity.name,
        filePath: entity.filePath,
      });
      if (entity.type === EntityType.FILE) filePathToFileId.set(entity.filePath, entity.stableId);
      if (isDeadCodeRoot(entity)) roots.add(entity.stableId);
    }
  });

  // Pass 2: stream relationships into a compact outgoing adjacency over edges
  // between real entities. Targets are stored as bare stable IDs, never full
  // relationship objects. Raw file-path sources (pre-reanchor rows) resolve via
  // the FILE-entity index. Note: the compact index + adjacency are O(repo);
  // only relationship/entity payloads are windowed.
  const outgoing = new Map<string, string[]>();
  await forEachPage(relationships, batchSize, (rows) => {
    for (const rel of rows) {
      if (!RELEVANT_TYPES.has(rel.type)) continue;
      const source = index.has(rel.sourceId) ? rel.sourceId : filePathToFileId.get(rel.sourceId);
      if (!source || !index.has(rel.targetId)) continue;
      const list = outgoing.get(source);
      if (list) list.push(rel.targetId);
      else outgoing.set(source, [rel.targetId]);
    }
  });

  // BFS from roots over outgoing edges (index-pointer queue, not shift()).
  const reachable = new Set<string>(roots);
  const queue = [...roots];
  let head = 0;
  while (head < queue.length) {
    const current = queue[head++]!;
    for (const target of outgoing.get(current) || []) {
      if (!reachable.has(target)) {
        reachable.add(target);
        queue.push(target);
      }
    }
  }

  // Pass 3: re-stream entities and emit full Entity objects only for dead
  // symbols (the output of the report), never for the whole repo.
  const deadCode: DeadCodeItem[] = [];
  const exportedButUnused: DeadCodeItem[] = [];
  await forEachPage(entities, batchSize, (rows) => {
    for (const entity of rows) {
      if (reachable.has(entity.stableId)) continue;
      if (entity.type === EntityType.FILE || entity.type === EntityType.CONFIG) continue;
      if (entity.language === Language.UNKNOWN) continue;
      if (entity.isExported) {
        exportedButUnused.push({ entity, reason: 'exported but never referenced from a reachable root' });
      } else {
        deadCode.push({ entity, reason: 'never referenced from an entrypoint or test root' });
      }
    }
  });

  return {
    deadCode,
    exportedButUnused,
    totalEntities,
    deadCount: deadCode.length,
  };
}

// --- Boundaries (streaming) --------------------------------------------------

export async function streamBoundaries(
  entities: PagedSource<Entity>,
  relationships: PagedSource<Relationship>,
  config?: DomainConfig,
  opts: StreamOptions = {}
): Promise<BoundaryReport> {
  const batchSize = resolveBatchSize(opts.batchSize);

  // Pass 1: stream entities into compact lookup maps. Keep stableId -> filePath
  // (for resolving relationship endpoints), filePath -> domain, and FILE-entity
  // name lookups for report rendering. Full entity objects are never retained.
  const stableIdToFile = new Map<string, string>();
  const filePaths = new Set<string>();
  const fileToEntity = new Map<string, { name: string }>();
  const domainByFile = new Map<string, string>();
  const summary = new Map<string, { fileCount: number; entityCount: number }>();

  await forEachPage(entities, batchSize, (rows) => {
    for (const entity of rows) {
      stableIdToFile.set(entity.stableId, entity.filePath);
      filePaths.add(entity.filePath);
      if (entity.type === EntityType.FILE) {
        fileToEntity.set(entity.filePath, { name: entity.name });
      }
      if (!domainByFile.has(entity.filePath)) {
        domainByFile.set(entity.filePath, entity.domain || inferDomain(entity.filePath));
      }
      const domain = domainByFile.get(entity.filePath) || inferDomain(entity.filePath);
      let entry = summary.get(domain);
      if (!entry) {
        entry = { fileCount: 0, entityCount: 0 };
        summary.set(domain, entry);
      }
      entry.entityCount++;
    }
  });

  for (const filePath of filePaths) {
    const domain = domainByFile.get(filePath) || inferDomain(filePath);
    const entry = summary.get(domain);
    if (entry) entry.fileCount++;
  }

  const filePathOf = (id: string): string | null => {
    if (filePaths.has(id)) return id;
    return stableIdToFile.get(id) || null;
  };

  const allowed = new Set((config?.allowedCrossDomain || []).map((entry) => `${entry.from}->${entry.to}`));
  const strict = Boolean(config?.strict);

  // Pass 2: stream relationships, emitting only cross-domain edges (the output
  // set of the report) rather than retaining the full relationship stream.
  const crossDomainEdges: BoundaryViolation[] = [];
  await forEachPage(relationships, batchSize, (rows) => {
    for (const rel of rows) {
      const sourceFile = filePathOf(rel.sourceId);
      const targetFile = filePathOf(rel.targetId);
      if (!sourceFile || !targetFile || sourceFile === targetFile) continue;

      const fromDomain = domainByFile.get(sourceFile) || inferDomain(sourceFile);
      const toDomain = domainByFile.get(targetFile) || inferDomain(targetFile);
      if (fromDomain === toDomain) continue;

      const allowedKey = `${fromDomain}->${toDomain}`;
      const isAllowed =
        allowed.has(allowedKey) ||
        allowed.has(`*->${toDomain}`) ||
        allowed.has(`${fromDomain}->*`) ||
        allowed.has('*->*');

      crossDomainEdges.push({
        source: { filePath: sourceFile, domain: fromDomain, name: fileToEntity.get(sourceFile)?.name || sourceFile },
        target: { filePath: targetFile, domain: toDomain, name: fileToEntity.get(targetFile)?.name || targetFile },
        relationshipType: rel.type,
        allowed: isAllowed,
      });
    }
  });

  const violations = strict
    ? crossDomainEdges.filter((edge) => !edge.allowed)
    : crossDomainEdges.filter((edge) => !edge.allowed && edge.relationshipType === RelationshipType.IMPORTS);

  const domains: DomainSummary[] = [...summary.entries()]
    .map(([name, counts]) => ({ name, fileCount: counts.fileCount, entityCount: counts.entityCount }))
    .sort((a, b) => a.name.localeCompare(b.name));

  return { domains, crossDomainEdges, violations, strict };
}
