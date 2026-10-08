export const EntityType = {
  REPOSITORY: 'Repository',
  PACKAGE: 'Package',
  FOLDER: 'Folder',
  FILE: 'File',
  CLASS: 'Class',
  INTERFACE: 'Interface',
  ENUM: 'Enum',
  FUNCTION: 'Function',
  METHOD: 'Method',
  CONSTRUCTOR: 'Constructor',
  PROPERTY: 'Property',
  API_ENDPOINT: 'ApiEndpoint',
  TEST: 'Test',
  TEST_SUITE: 'TestSuite',
  CONFIG: 'Config',
  MODULE: 'Module',
  MODEL: 'Model',
  VARIABLE: 'Variable',
  TYPE_ALIAS: 'TypeAlias',
} as const;

export type EntityType = (typeof EntityType)[keyof typeof EntityType];

export const RelationshipType = {
  IMPORTS: 'IMPORTS',
  EXPORTS: 'EXPORTS',
  CALLS: 'CALLS',
  REFERENCES: 'REFERENCES',
  EXTENDS: 'EXTENDS',
  IMPLEMENTS: 'IMPLEMENTS',
  OVERRIDES: 'OVERRIDES',
  CONTAINS: 'CONTAINS',
  OWNS: 'OWNS',
  COMPOSES: 'COMPOSES',
  READS_FROM: 'READS_FROM',
  WRITES_TO: 'WRITES_TO',
  TESTS: 'TESTS',
  COVERS: 'COVERS',
  EXPOSES: 'EXPOSES',
  HANDLES: 'HANDLES',
  DEPENDS_ON: 'DEPENDS_ON',
  BELONGS_TO: 'BELONGS_TO',
  CHANGED_BY: 'CHANGED_BY',
  DEFINED_IN: 'DEFINED_IN',
} as const;

export type RelationshipType = (typeof RelationshipType)[keyof typeof RelationshipType];

export const Language = {
  TYPESCRIPT: 'typescript',
  JAVASCRIPT: 'javascript',
  PYTHON: 'python',
  UNKNOWN: 'unknown',
} as const;

export type Language = (typeof Language)[keyof typeof Language];

export interface Entity {
  id: string;
  stableId: string;
  repoPath?: string;
  name: string;
  type: EntityType;
  language: Language;
  filePath: string;
  startLine: number;
  endLine: number;
  startColumn: number;
  endColumn: number;
  signature?: string;
  docstring?: string;
  purpose?: string;
  responsibility?: string;
  domain?: string;
  architecturalRole?: string;
  isExported: boolean;
  isTest: boolean;
  confidence: number;
  firstSeenCommit?: string;
  lastSeenCommit?: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface Relationship {
  id: string;
  sourceId: string;
  targetId: string;
  type: RelationshipType;
  filePath: string;
  line?: number;
  confidence: number;
  metadata?: Record<string, unknown>;
  createdAt: Date;
  updatedAt: Date;
}

export interface Commit {
  hash: string;
  repoPath?: string;
  message: string;
  author: string;
  date: Date;
  filesChanged: string[];
}

export interface FileChange {
  filePath: string;
  additions: number;
  deletions: number;
  status: 'added' | 'modified' | 'deleted' | 'renamed';
  oldPath?: string;
}

export interface FileChurnRow {
  filePath: string;
  commits: number;
  additions: number;
  deletions: number;
  lastChanged: Date;
}

export interface GraphEvent {
  type: 'entity_created' | 'entity_updated' | 'entity_deleted' | 'relationship_created' | 'relationship_updated' | 'relationship_deleted';
  entity?: Entity;
  relationship?: Relationship;
  timestamp: Date;
}

export interface ParseResult {
  filePath: string;
  language: Language;
  entities: Entity[];
  relationships: Relationship[];
  errors: ParseError[];
}

export interface ParseError {
  filePath: string;
  line: number;
  column: number;
  message: string;
}

export interface TraversalResult {
  nodes: Entity[];
  edges: Relationship[];
  paths: Entity[][];
}

export interface ImpactAnalysis {
  directImpact: Entity[];
  indirectImpact: Entity[];
  affectedFiles: string[];
  riskScore: number;
}

export interface ContextPack {
  entity: Entity;
  dependencies: Entity[];
  dependents: Entity[];
  recentChanges: Commit[];
  similarEntities: Entity[];
  metadata: {
    packageName: string;
    entityCount: number;
    dependencyDepth: number;
  };
  tokenCount: number;
}

export interface TaskContextFile {
  filePath: string;
  domain?: string;
  entityCount: number;
}

export interface TaskContextRisk {
  files: Array<{
    filePath: string;
    commitCount: number;
    churnScore: number;
    daysSinceLastChange: number | null;
    riskScore: number;
  }>;
  entityStaleness: Array<{
    stableId: string;
    name: string;
    filePath: string;
    commitCount: number;
    stalenessDays: number | null;
  }>;
}

export interface TaskContextBoundary {
  source: string;
  target: string;
  type: string;
  message: string;
}

export interface TaskContextPack {
  task: string;
  repoPath?: string;
  focalEntities: Entity[];
  files: TaskContextFile[];
  relationships: Relationship[];
  recentChanges: Commit[];
  risk: TaskContextRisk;
  boundaries: {
    domains: string[];
    violations: TaskContextBoundary[];
  };
  metadata: {
    entityCount: number;
    fileCount: number;
    relationshipCount: number;
    rankingStrategy: string;
  };
  tokenCount: number;
}

export type ScanType = 'full' | 'incremental' | 'working-tree' | 'commit';

export interface ScanPhaseReport {
  name: string;
  entityCount: number;
  relationshipCount: number;
  durationMs: number;
}

export interface ScanReport {
  scanType: ScanType;
  repoPath: string;
  commit?: string;
  filesDiscovered: number;
  filesParsed: number;
  entitiesExtracted: number;
  relationshipsExtracted: number;
  embeddingsGenerated: number;
  entitiesStored: number;
  relationshipsStored: number;
  phases: ScanPhaseReport[];
  totalDurationMs: number;
  startedAt: string;
  completedAt: string;
}

// Live status of a watched repository (5.6) — surfaced by `GET /api/status`
// and used by the frontend "live" indicator.
export interface RepoStatus {
  repoPath: string;
  watching: boolean;
  lastScanAt: string | null;
  pendingChanges: number;
}

export const JobType = {
  VERIFY: 'verify',
  REPAIR: 'repair',
} as const;

export type JobType = (typeof JobType)[keyof typeof JobType];

export const JobStatus = {
  PENDING: 'pending',
  RUNNING: 'running',
  COMPLETED: 'completed',
  FAILED: 'failed',
} as const;

export type JobStatus = (typeof JobStatus)[keyof typeof JobStatus];

export interface Job {
  id: string;
  type: JobType;
  status: JobStatus;
  repositoryPath: string;
  commitHash?: string;
  filesToProcess: string[];
  result?: unknown;
  error?: string;
  startedAt?: Date;
  completedAt?: Date;
  createdAt: Date;
}

export interface TypeCount {
  type: string;
  count: number;
}

// PostgreSQL integrity report (single-store). `danglingSources` are
// relationships whose source is not a known entity (an anomaly — sources are
// always entities after persistence). Relationships pointing at non-entity
// targets are expected (external/unresolved imports) and reported only as the
// informational `unresolvedTargets` count.
export interface VerificationReport {
  repoPath: string;
  ranAt: string;
  entityCounts: TypeCount[];
  relationshipCounts: TypeCount[];
  entityTotal: number;
  relationshipTotal: number;
  duplicateStableIds: number;
  danglingSources: string[];
  danglingSourceCount: number;
  unresolvedTargets: number;
  staleFiles: string[];
  staleFileCount: number;
  entitiesWithoutEmbedding: number;
  ok: boolean;
}

export interface RepairReport {
  repoPath: string;
  ranAt: string;
  staleFilesRemoved: number;
  embeddingsGenerated: number;
  verifyAfter: VerificationReport;
}
