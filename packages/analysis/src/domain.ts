import { Entity, EntityType } from '@repo-memory/shared';

export interface DomainConfigDomain {
  name: string;
  paths: string[];
  default?: boolean;
}

export interface DomainConfig {
  domains: DomainConfigDomain[];
  allowedCrossDomain: Array<{ from: string; to: string }>;
  strict?: boolean;
}

const DOMAIN_RULES: Array<{ pattern: RegExp; domain: string }> = [
  { pattern: /controllers?/i, domain: 'web' },
  { pattern: /routes?/i, domain: 'web' },
  { pattern: /views?/i, domain: 'web' },
  { pattern: /pages?/i, domain: 'web' },
  { pattern: /api\//i, domain: 'web' },
  { pattern: /models?/i, domain: 'data' },
  { pattern: /entities?/i, domain: 'data' },
  { pattern: /schemas?/i, domain: 'data' },
  { pattern: /migrations?/i, domain: 'data' },
  { pattern: /repositories?/i, domain: 'data' },
  { pattern: /services?/i, domain: 'business' },
  { pattern: /usecases?/i, domain: 'business' },
  { pattern: /domain\//i, domain: 'business' },
  { pattern: /utils?/i, domain: 'shared' },
  { pattern: /helpers?/i, domain: 'shared' },
  { pattern: /lib\//i, domain: 'shared' },
  { pattern: /common\//i, domain: 'shared' },
  { pattern: /shared\//i, domain: 'shared' },
  { pattern: /config/i, domain: 'config' },
  { pattern: /settings/i, domain: 'config' },
  { pattern: /tests?/i, domain: 'test' },
  { pattern: /__tests__/i, domain: 'test' },
  { pattern: /spec/i, domain: 'test' },
  { pattern: /workers?/i, domain: 'jobs' },
  { pattern: /jobs/i, domain: 'jobs' },
  { pattern: /tasks/i, domain: 'jobs' },
  { pattern: /cli\//i, domain: 'cli' },
  { pattern: /scripts\//i, domain: 'cli' },
  { pattern: /infrastructure/i, domain: 'infrastructure' },
  { pattern: /infra\//i, domain: 'infrastructure' },
  { pattern: /core\//i, domain: 'infrastructure' },
];

// Infers a bounded-context/domain label from a file's directory layout.
export function inferDomain(filePath: string): string {
  const normalized = filePath.replace(/\\/g, '/');
  const segments = normalized.split('/').slice(0, -1);

  for (const segment of segments) {
    for (const rule of DOMAIN_RULES) {
      if (rule.pattern.test(segment)) return rule.domain;
    }
  }

  const topLevel = segments[0];
  return topLevel ? topLevel.toLowerCase() : 'core';
}

// Infers an architectural role from a file's directory layout and entity type.
export function inferArchitecturalRole(filePath: string, entityType: EntityType): string {
  const normalized = filePath.replace(/\\/g, '/');
  if (entityType === EntityType.API_ENDPOINT) return 'api';
  if (entityType === EntityType.TEST || entityType === EntityType.TEST_SUITE) return 'test';
  if (entityType === EntityType.CONFIG) return 'config';
  if (/controllers?|routes?|views?|pages?/i.test(normalized)) return 'presentation';
  if (/models?|entities?|schemas?|migrations?|repositories?/i.test(normalized)) return 'data';
  if (/services?|usecases?|domain\//i.test(normalized)) return 'application';
  if (/utils?|helpers?|lib\/|common\/|shared\//i.test(normalized)) return 'shared utility';
  return 'implementation';
}

function domainForFile(filePath: string, config?: DomainConfig): string {
  if (config?.domains && config.domains.length > 0) {
    const normalized = filePath.replace(/\\/g, '/');
    for (const domain of config.domains) {
      if (domain.paths.some(p => normalized.includes(p))) {
        return domain.name;
      }
    }
    const defaultDomain = config.domains.find(d => d.default);
    if (defaultDomain) return defaultDomain.name;
  }
  return inferDomain(filePath);
}

// Populates domain / architecturalRole on entities that don't have them yet.
export function applyDomainMetadata(entities: Entity[], config?: DomainConfig): void {
  for (const entity of entities) {
    entity.domain = entity.domain || domainForFile(entity.filePath, config);
    entity.architecturalRole = entity.architecturalRole || inferArchitecturalRole(entity.filePath, entity.type);
  }
}

export function parseDomainConfig(json: string): DomainConfig {
  const raw = JSON.parse(json);
  return {
    domains: Array.isArray(raw.domains) ? raw.domains : [],
    allowedCrossDomain: Array.isArray(raw.allowedCrossDomain) ? raw.allowedCrossDomain : [],
    strict: Boolean(raw.strict),
  };
}
