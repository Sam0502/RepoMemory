import { Entity, Relationship, RelationshipType, EntityType } from '@repo-memory/shared';
import { DomainConfig, inferDomain } from './domain.js';

export interface BoundaryEndpoint {
  filePath: string;
  domain: string;
  name: string;
}

export interface BoundaryViolation {
  source: BoundaryEndpoint;
  target: BoundaryEndpoint;
  relationshipType: RelationshipType;
  allowed: boolean;
}

export interface DomainSummary {
  name: string;
  fileCount: number;
  entityCount: number;
}

export interface BoundaryReport {
  domains: DomainSummary[];
  crossDomainEdges: BoundaryViolation[];
  violations: BoundaryViolation[];
  strict: boolean;
}

// Detects cross-domain edges between files (imports, resolved calls/references)
// and flags those not permitted by the boundary config (or all when strict).
export function validateBoundaries(entities: Entity[], relationships: Relationship[], config?: DomainConfig): BoundaryReport {
  const stableIdToFile = new Map<string, string>();
  const filePaths = new Set<string>();
  const fileToEntity = new Map<string, { name: string }>();

  for (const entity of entities) {
    stableIdToFile.set(entity.stableId, entity.filePath);
    filePaths.add(entity.filePath);
    if (entity.type === EntityType.FILE) {
      fileToEntity.set(entity.filePath, { name: entity.name });
    }
  }

  const domainByFile = new Map<string, string>();
  for (const entity of entities) {
    if (!domainByFile.has(entity.filePath)) {
      domainByFile.set(entity.filePath, entity.domain || inferDomain(entity.filePath));
    }
  }

  function filePathOf(id: string): string | null {
    if (filePaths.has(id)) return id;
    return stableIdToFile.get(id) || null;
  }

  const allowed = new Set((config?.allowedCrossDomain || []).map(entry => `${entry.from}->${entry.to}`));
  const strict = Boolean(config?.strict);

  const crossDomainEdges: BoundaryViolation[] = [];

  for (const rel of relationships) {
    const sourceFile = filePathOf(rel.sourceId);
    const targetFile = filePathOf(rel.targetId);
    if (!sourceFile || !targetFile || sourceFile === targetFile) continue;

    const fromDomain = domainByFile.get(sourceFile) || inferDomain(sourceFile);
    const toDomain = domainByFile.get(targetFile) || inferDomain(targetFile);
    if (fromDomain === toDomain) continue;

    const allowedKey = `${fromDomain}->${toDomain}`;
    const isAllowed = allowed.has(allowedKey) || allowed.has(`*->${toDomain}`) || allowed.has(`${fromDomain}->*`) || allowed.has('*->*');
    crossDomainEdges.push({
      source: { filePath: sourceFile, domain: fromDomain, name: fileToEntity.get(sourceFile)?.name || sourceFile },
      target: { filePath: targetFile, domain: toDomain, name: fileToEntity.get(targetFile)?.name || targetFile },
      relationshipType: rel.type,
      allowed: isAllowed,
    });
  }

  const violations = strict
    ? crossDomainEdges.filter(edge => !edge.allowed)
    : crossDomainEdges.filter(edge => !edge.allowed && edge.relationshipType === RelationshipType.IMPORTS);

  // Domain summary
  const summary = new Map<string, { fileCount: number; entityCount: number }>();
  for (const entity of entities) {
    const domain = domainByFile.get(entity.filePath) || inferDomain(entity.filePath);
    let entry = summary.get(domain);
    if (!entry) {
      entry = { fileCount: 0, entityCount: 0 };
      summary.set(domain, entry);
    }
    entry.entityCount++;
  }
  for (const filePath of filePaths) {
    const domain = domainByFile.get(filePath) || inferDomain(filePath);
    const entry = summary.get(domain);
    if (entry) entry.fileCount++;
  }

  const domains: DomainSummary[] = [...summary.entries()]
    .map(([name, counts]) => ({ name, fileCount: counts.fileCount, entityCount: counts.entityCount }))
    .sort((a, b) => a.name.localeCompare(b.name));

  return { domains, crossDomainEdges, violations, strict };
}
