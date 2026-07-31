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
