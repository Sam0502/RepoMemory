import { Pool } from 'pg';
import { GraphClient } from '@repo-memory/graph';
import { EntityRepository, RelationshipRepository, CommitRepository, JobRepository, migrate, createPool } from '@repo-memory/storage';
import { GitOperations } from '@repo-memory/ingestion';
import {
  TreeSitterParser, getLanguageFromFilePath, shouldParseFile, isConfigFilePath,
  configureEmbeddings, generateEntityEmbedding, getProviderName,
  SymbolIndex, RelationshipResolver, createFileEntity,
  applyDomainMetadata, parseDomainConfig, ChangeAnalyzer,
  streamDeadCode, streamBoundaries, resolveBatchSize
} from '@repo-memory/analysis';
import type { EmbeddingConfig, DeadCodeReport, DomainConfig, BoundaryReport } from '@repo-memory/analysis';
import { Language, RelationshipType, getLogger, metrics, registerDefaultMetrics } from '@repo-memory/shared';
import type { Logger } from '@repo-memory/shared';
import type { Entity, Relationship, ParseResult, ScanReport, ScanPhaseReport, ScanType, Job, JobType, VerificationReport, RepairReport, TypeCountDelta } from '@repo-memory/shared';
import { readFileSync } from 'fs';
import { join } from 'path';

export interface OrchestratorConfig {
  repoPath: string;
  neo4jUri?: string;
  neo4jUser?: string;
  neo4jPassword?: string;
  pgHost?: string;
  pgPort?: number;
  pgDatabase?: string;
  pgUser?: string;
  pgPassword?: string;
  embeddings?: EmbeddingConfig;
}

interface ProcessStats {
  filesParsed: number;
  entitiesExtracted: number;
  relationshipsExtracted: number;
  embeddingsGenerated: number;
  entitiesStored: number;
  relationshipsStored: number;
}

interface ScanState {
  type: ScanType;
  commit?: string;
  startedAt: Date;
  totalStart: number;
  phaseStart: number;
  phases: ScanPhaseReport[];
}

export class Orchestrator {
  private logger: Logger;
  private graphClient: GraphClient;
  private pgPool!: Pool;
  private entityRepo!: EntityRepository;
  private relationshipRepo!: RelationshipRepository;
  private commitRepo!: CommitRepository;
  private jobRepo!: JobRepository;
  private gitOps: GitOperations;
  private config: OrchestratorConfig;
  private parserCache: Map<Language, TreeSitterParser> = new Map();
  private domainConfig: DomainConfig | null = null;
  private changeAnalyzer: ChangeAnalyzer | null = null;
  private scanState: ScanState | null = null;

  constructor(config: OrchestratorConfig) {
    this.config = config;
    this.logger = getLogger({ component: 'orchestrator', repoPath: config.repoPath });
    this.graphClient = new GraphClient(
      config.neo4jUri,
      config.neo4jUser,
      config.neo4jPassword
    );
    this.gitOps = new GitOperations(config.repoPath);
  }

  async initialize(): Promise<void> {
    registerDefaultMetrics();
    this.pgPool = await createPool({
      host: this.config.pgHost || 'localhost',
      port: this.config.pgPort || 5433,
      database: this.config.pgDatabase || 'repo_memory',
      user: this.config.pgUser || 'repo_memory',
      password: this.config.pgPassword || 'repo-memory-password',
    });
    this.entityRepo = new EntityRepository(this.pgPool, this.config.repoPath);
    this.relationshipRepo = new RelationshipRepository(this.pgPool, this.config.repoPath);
    this.commitRepo = new CommitRepository(this.pgPool, this.config.repoPath);
    this.jobRepo = new JobRepository(this.pgPool);
    this.logger.info('Initializing Repository Memory Engine...');

    // Verify database connections
    await this.graphClient.verifyConnectivity();

    // Run migrations
    await migrate(this.pgPool);

    // Create Neo4j schema
    await this.graphClient.createSchema();

    // Initialize embeddings
    if (this.config.embeddings) {
      const fallback = process.env.GEMINI_API_KEY
        ? { provider: 'gemini' as const, gemini: { apiKey: process.env.GEMINI_API_KEY } }
        : undefined;
      configureEmbeddings(this.config.embeddings, fallback);
      this.logger.info({ provider: getProviderName() }, 'Embeddings initialized');
    }

    // Pre-initialize parsers for supported languages
    await this.initializeParsers();

    // Load optional boundary/domain config
    this.domainConfig = this.loadDomainConfig();

    this.logger.info('Initialization complete.');
  }

  private loadDomainConfig(): DomainConfig | null {
    const configPath = join(this.config.repoPath, '.repomemory', 'boundaries.json');
    try {
      const content = readFileSync(configPath, 'utf-8');
      const config = parseDomainConfig(content);
      this.logger.info({ domainCount: config.domains.length }, 'Loaded domain/boundary config');
      return config;
    } catch {
      return null;
    }
  }

  private async initializeParsers(): Promise<void> {
    const supportedLanguages = [Language.TYPESCRIPT, Language.JAVASCRIPT, Language.PYTHON];

    for (const lang of supportedLanguages) {
      const parser = new TreeSitterParser(lang);
      await parser.initialize();
      this.parserCache.set(lang, parser);
      this.logger.debug({ language: lang }, 'Initialized parser');
    }
  }

  private async getParser(language: Language): Promise<TreeSitterParser> {
    let parser = this.parserCache.get(language);
    if (!parser) {
      parser = new TreeSitterParser(language);
      await parser.initialize();
      this.parserCache.set(language, parser);
    }
    return parser;
  }

  // --- Scan telemetry -------------------------------------------------------

  private beginScan(type: ScanType, commit?: string): void {
    this.scanState = {
      type,
      commit,
      startedAt: new Date(),
      totalStart: performance.now(),
      phaseStart: performance.now(),
      phases: [],
    };
  }

  private endPhase(name: string, entityCount: number, relationshipCount: number, durationMs?: number): void {
    if (!this.scanState) return;
    const now = performance.now();
    this.scanState.phases.push({
      name,
      entityCount,
      relationshipCount,
      durationMs: Math.round(durationMs ?? now - this.scanState.phaseStart),
    });
    this.scanState.phaseStart = now;
  }

  private finishScan(
    filesDiscovered: number,
    filesParsed: number,
    entitiesExtracted: number,
    relationshipsExtracted: number,
    embeddingsGenerated: number,
    entitiesStored: number,
    relationshipsStored: number,
  ): ScanReport {
    const state = this.scanState;
    if (!state) {
      throw new Error('No scan in progress');
    }
    const totalDurationMs = Math.round(performance.now() - state.totalStart);
    const report: ScanReport = {
      scanType: state.type,
      repoPath: this.config.repoPath,
      commit: state.commit,
      filesDiscovered,
      filesParsed,
      entitiesExtracted,
      relationshipsExtracted,
      embeddingsGenerated,
      entitiesStored,
      relationshipsStored,
      phases: state.phases,
      totalDurationMs,
      startedAt: state.startedAt.toISOString(),
      completedAt: new Date().toISOString(),
    };

    metrics.observe('repo_memory_scan_duration_seconds', totalDurationMs / 1000);
    metrics.set('repo_memory_last_scan_timestamp_seconds', Date.now() / 1000);
    this.logger.info(
      { scanType: state.type, commit: state.commit, totalDurationMs, entitiesStored, relationshipsStored },
      'Scan completed'
    );
    this.scanState = null;
    return report;
  }

  // --- Scan entry points ----------------------------------------------------

  async scanFullRepository(): Promise<ScanReport> {
    this.beginScan('full');
    this.logger.info('Starting full repository scan');

    // discover
    const discoverStart = performance.now();
    const files = await this.getSourceFiles(this.config.repoPath);
    const discoverMs = performance.now() - discoverStart;
    this.logger.info({ filesDiscovered: files.length }, 'Discovered source files');

    // parse
    const results: ParseResult[] = [];
    let parseMs = 0;
    let filesParsed = 0;
    let entityCount = 0;
    let relCount = 0;

    for (const file of files) {
      try {
        const parseStart = performance.now();
        const result = await this.parseFile(file);
        parseMs += performance.now() - parseStart;
        if (!result) continue;
        results.push(result);
        filesParsed++;
        entityCount += result.entities.length;
        relCount += result.relationships.length;
      } catch (error) {
        this.logger.error({ err: error, file }, 'Error processing file');
      }
    }

    // resolve
    const resolveStart = performance.now();
    const { fileEntities, resolvedByFile } = await this.resolveResults(results);
    const resolveMs = performance.now() - resolveStart;

    // embed
    const embeddings = new Map<string, number[]>();
    let embedMs = 0;
    let embedCount = 0;
    for (const result of results) {
      const embedStart = performance.now();
      const embs = await this.generateEmbeddings(result);
      embedMs += performance.now() - embedStart;
      embedCount += embs.size;
      embs.forEach((embedding, stableId) => embeddings.set(stableId, embedding));
    }

    // Fresh full scan: clear previous data for this repo before repopulating
    await this.entityRepo.deleteAll();
    await this.relationshipRepo.deleteAll();
    await this.graphClient.deleteAll(this.config.repoPath);

    // persist
    const persistStart = performance.now();
    const { entitiesStored, relationshipsStored } = await this.persistResolved(results, fileEntities, resolvedByFile, embeddings);
    const persistMs = performance.now() - persistStart;

    this.endPhase('discover', 0, 0, discoverMs);
    this.endPhase('parse', entityCount, relCount, parseMs);
    this.endPhase('resolve', 0, relCount, resolveMs);
    this.endPhase('embed', embedCount, 0, embedMs);
    this.endPhase('persist', entitiesStored, relationshipsStored, persistMs);

    // Record the latest commit after full scan
    await this.recordCurrentCommit();

    // Ingest commit history so ownership/domain reports have data
    await this.recordCommitHistory(100);

    // Back-fill first/last seen commit hashes onto entities from history
    await this.annotateEntitiesWithCommits();

    return this.finishScan(
      files.length,
      filesParsed,
      entityCount,
      relCount,
      embedCount,
      entitiesStored,
      relationshipsStored,
    );
  }

  private async recordCurrentCommit(): Promise<void> {
    try {
      const commit = await this.gitOps.getLatestCommit();
      if (commit) {
        const diff = await this.gitOps.getWorkingTreeDiff();
        await this.commitRepo.upsert({
          ...commit,
          filesChanged: diff.map(d => d.filePath),
          fileChanges: diff,
        });
        await this.updateRepoState(commit.hash);
      }
    } catch (error) {
      this.logger.error({ err: error }, 'Failed to record commit');
    }
  }

  // Upsert the last `limit` commits of git history so per-file ownership
  // and commit activity reports have data to work from.
  private async recordCommitHistory(limit: number = 100): Promise<void> {
    try {
      const commits = await this.gitOps.getRecentCommitsWithChanges(limit);
      for (const commit of commits) {
        await this.commitRepo.upsert(commit);
      }
      if (commits.length > 0) {
        this.logger.info({ commitCount: commits.length }, 'Recorded commit history');
      }
    } catch (error) {
      this.logger.error({ err: error }, 'Failed to record commit history');
    }
  }

  // Back-fill firstSeenCommit/lastSeenCommit on entities from the commit
  // history, matching by file path. Git paths use `/`; entity file paths may
  // use `\` on Windows, so separators are normalized for the comparison.
  private async annotateEntitiesWithCommits(): Promise<void> {
    try {
      const result = await this.pgPool.query(
        `SELECT fc.file_path, c.hash, c.date
         FROM file_changes fc
         JOIN commits c ON c.hash = fc.commit_hash
         WHERE c.repo_path = $1
         ORDER BY c.date ASC`,
        [this.config.repoPath]
      );

      const firstSeen = new Map<string, string>();
      const lastSeen = new Map<string, string>();
      for (const row of result.rows) {
        const key = row.file_path.replace(/\\/g, '/');
        if (!firstSeen.has(key)) firstSeen.set(key, row.hash);
        lastSeen.set(key, row.hash);
      }

      for (const [fileKey, hash] of firstSeen) {
        await this.pgPool.query(
          `UPDATE entities
           SET first_seen_commit = $1, updated_at = NOW()
           WHERE repo_path = $2 AND REPLACE(file_path, '\\', '/') = $3
             AND first_seen_commit IS NULL`,
          [hash, this.config.repoPath, fileKey]
        );
      }
      for (const [fileKey, hash] of lastSeen) {
        await this.pgPool.query(
          `UPDATE entities
           SET last_seen_commit = $1, updated_at = NOW()
           WHERE repo_path = $2 AND REPLACE(file_path, '\\', '/') = $3`,
          [hash, this.config.repoPath, fileKey]
        );
      }

      this.logger.info({ fileCount: firstSeen.size }, 'Annotated entity first/last seen commits');
    } catch (error) {
      this.logger.error({ err: error }, 'Failed to annotate entities with commits');
    }
  }

  private async updateRepoState(commitHash: string): Promise<void> {
    try {
      await this.pgPool.query(
        `INSERT INTO repo_state (repo_path, last_commit_hash, last_scan_at)
         VALUES ($1, $2, NOW())
         ON CONFLICT (repo_path) DO UPDATE SET
           last_commit_hash = EXCLUDED.last_commit_hash,
           last_scan_at = NOW()`,
        [this.config.repoPath, commitHash]
      );
    } catch (error) {
      this.logger.error({ err: error }, 'Failed to update repo state');
    }
  }

  async scanFromCommit(commitHash?: string): Promise<ScanReport> {
    this.logger.info('Starting incremental scan from commit');

    if (!commitHash) {
      const lastCommit = await this.gitOps.getLastCommitHash();
      if (!lastCommit) {
        this.logger.info('No commits found. Running full scan.');
        return this.scanFullRepository();
      }
      commitHash = lastCommit;
    }

    this.beginScan('commit', commitHash);

    const discoverStart = performance.now();
    const changes = await this.gitOps.getDiffBetweenCommits(commitHash, 'HEAD');
    const discoverMs = performance.now() - discoverStart;
    this.logger.info({ filesDiscovered: changes.length, sinceCommit: commitHash }, 'Discovered changed files');

    const stats = await this.processChanges(changes);

    this.endPhase('discover', 0, 0, discoverMs);

    await this.recordCurrentCommit();
    await this.annotateEntitiesWithCommits();

    return this.finishScan(changes.length, stats.filesParsed, stats.entitiesExtracted, stats.relationshipsExtracted, stats.embeddingsGenerated, stats.entitiesStored, stats.relationshipsStored);
  }

  async scanIncremental(): Promise<ScanReport> {
    this.logger.info('Starting incremental scan');

    const lastCommitHash = await this.getLastScannedCommit();
    if (!lastCommitHash) {
      this.logger.info('No previous scan state found. Running full scan.');
      return this.scanFullRepository();
    }

    this.beginScan('incremental', lastCommitHash);

    const discoverStart = performance.now();
    const changes = await this.gitOps.getDiffBetweenCommits(lastCommitHash, 'HEAD');
    const discoverMs = performance.now() - discoverStart;
    this.logger.info({ filesDiscovered: changes.length, sinceCommit: lastCommitHash }, 'Discovered changed files');

    const stats = await this.processChanges(changes);

    this.endPhase('discover', 0, 0, discoverMs);

    await this.recordCurrentCommit();
    await this.annotateEntitiesWithCommits();

    return this.finishScan(changes.length, stats.filesParsed, stats.entitiesExtracted, stats.relationshipsExtracted, stats.embeddingsGenerated, stats.entitiesStored, stats.relationshipsStored);
  }

  private async getLastScannedCommit(): Promise<string | null> {
    try {
      const result = await this.pgPool.query(
        'SELECT last_commit_hash FROM repo_state WHERE repo_path = $1',
        [this.config.repoPath]
      );
      return result.rows[0]?.last_commit_hash || null;
    } catch {
      return null;
    }
  }

  async scanWorkingTree(): Promise<ScanReport> {
    this.beginScan('working-tree');
    this.logger.info('Scanning working tree changes');

    const discoverStart = performance.now();
    const status = await this.gitOps.getStatus();
    const changes: Array<{ filePath: string; status: string }> = [
      ...status.modified.map(file => ({ filePath: file, status: 'modified' })),
      ...status.added.map(file => ({ filePath: file, status: 'added' })),
      ...status.deleted.map(file => ({ filePath: file, status: 'deleted' })),
    ];
    const discoverMs = performance.now() - discoverStart;
    this.logger.info({ filesDiscovered: changes.length }, 'Discovered changed files');

    const stats = await this.processChanges(changes);

    this.endPhase('discover', 0, 0, discoverMs);

    await this.recordCurrentCommit();
    await this.annotateEntitiesWithCommits();

    return this.finishScan(changes.length, stats.filesParsed, stats.entitiesExtracted, stats.relationshipsExtracted, stats.embeddingsGenerated, stats.entitiesStored, stats.relationshipsStored);
  }

  // Parse, resolve, and persist a batch of changed files. For incremental scans the
  // repo-wide symbol index is loaded from the database so relationships still resolve
  // against definitions in files that were not re-parsed. Records per-phase telemetry
  // into the active scan state.
  private async processChanges(changes: Array<{ filePath: string; status: string }>): Promise<ProcessStats> {
    let parseMs = 0;
    let embedMs = 0;
    let filesParsed = 0;
    let entityCount = 0;
    let relCount = 0;
    let embedCount = 0;

    const resolveStart = performance.now();
    const index = await this.loadSymbolIndex();
    const resolveMs = performance.now() - resolveStart;

    const results: ParseResult[] = [];
    const embeddings = new Map<string, number[]>();

    for (const change of changes) {
      if (change.status === 'deleted') {
        await this.handleFileDeletion(change.filePath);
        continue;
      }
      try {
        const parseStart = performance.now();
        const result = await this.parseFile(join(this.config.repoPath, change.filePath));
        parseMs += performance.now() - parseStart;
        if (!result) continue;
        results.push(result);
        filesParsed++;
        entityCount += result.entities.length;
        relCount += result.relationships.length;
        index.addFile(result.filePath);
        index.addEntities(result.entities);
        index.addEntity(createFileEntity(result.filePath, this.config.repoPath));
      } catch (error) {
        this.logger.error({ err: error, file: change.filePath }, 'Error processing file');
      }
    }

    for (const result of results) {
      index.registerRelationships(result.relationships);
    }

    const resolver = new RelationshipResolver(index, this.config.repoPath);
    let entitiesStored = 0;
    let relationshipsStored = 0;
    for (const result of results) {
      const fileEntity = createFileEntity(result.filePath, this.config.repoPath);
      const resolved = resolver.resolveRelationships(result.relationships);
      const embedStart = performance.now();
      const embs = await this.generateEmbeddings(result);
      embedMs += performance.now() - embedStart;
      embedCount += embs.size;
      embs.forEach((embedding, stableId) => embeddings.set(stableId, embedding));
      entitiesStored += await this.persistFileEntities(result, fileEntity, embeddings);
      relationshipsStored += await this.persistFileRelationships(result, fileEntity, resolved);
    }

    this.endPhase('parse', entityCount, relCount, parseMs);
    this.endPhase('resolve', 0, relCount, resolveMs);
    this.endPhase('embed', embedCount, 0, embedMs);
    this.endPhase('persist', entitiesStored, relationshipsStored);

    return {
      filesParsed,
      entitiesExtracted: entityCount,
      relationshipsExtracted: relCount,
      embeddingsGenerated: embedCount,
      entitiesStored,
      relationshipsStored,
    };
  }

  private async loadSymbolIndex(): Promise<SymbolIndex> {
    const index = new SymbolIndex(this.config.repoPath);

    const limit = 5000;
    let offset = 0;
    while (true) {
      const entities = await this.entityRepo.findAll(limit, offset);
      for (const entity of entities) {
        index.addEntity(entity);
        index.addFile(entity.filePath);
      }
      if (entities.length < limit) break;
      offset += limit;
    }

    const importRelationships = await this.relationshipRepo.findByType(RelationshipType.IMPORTS);
    index.registerRelationships(importRelationships);

    return index;
  }

  private async parseFile(filePath: string): Promise<ParseResult | null> {
    const isConfig = isConfigFilePath(filePath);
    if (!shouldParseFile(filePath) && !isConfig) {
      return null;
    }

    const relativePath = filePath.replace(this.config.repoPath, '').replace(/^[/\\]/, '');

    // Read file content
    let content: string;
    try {
      content = readFileSync(filePath, 'utf-8');
    } catch (error) {
      this.logger.error({ err: error, file: filePath }, 'Failed to read file');
      return null;
    }

    // Parse file using cached parser
    const language = getLanguageFromFilePath(filePath);
    const parser = await this.getParser(language);

    const result = await parser.parse(relativePath, content, this.config.repoPath);

    this.logger.debug(
      { file: relativePath, entityCount: result.entities.length, relationshipCount: result.relationships.length },
      'Parsed file'
    );
    return result;
  }

  private async generateEmbeddings(result: ParseResult): Promise<Map<string, number[]>> {
    const embeddings = new Map<string, number[]>();
    for (const entity of result.entities) {
      try {
        const embedding = await generateEntityEmbedding(entity.name, entity.type, entity.filePath);
        embeddings.set(entity.stableId, embedding);
      } catch (error) {
        this.logger.error({ err: error, entity: entity.name }, 'Failed to generate embedding');
      }
    }
    return embeddings;
  }

  // Build the symbol index and resolve every file's relationships against it.
  // Split from persistence so scans can time the resolve phase independently.
  private async resolveResults(results: ParseResult[]): Promise<{
    fileEntities: Map<string, Entity>;
    resolvedByFile: Map<string, Relationship[]>;
  }> {
    const index = new SymbolIndex(this.config.repoPath);
    const fileEntities = new Map<string, Entity>();

    for (const result of results) {
      index.addFile(result.filePath);
    }
    for (const result of results) {
      const fileEntity = createFileEntity(result.filePath, this.config.repoPath);
      fileEntities.set(result.filePath, fileEntity);
    }
    for (const result of results) {
      index.addEntities(result.entities);
    }
    for (const fileEntity of fileEntities.values()) {
      index.addEntity(fileEntity);
    }
    for (const result of results) {
      index.registerRelationships(result.relationships);
    }

    const resolver = new RelationshipResolver(index, this.config.repoPath);
    const resolvedByFile = new Map<string, Relationship[]>();

    for (const result of results) {
      const resolved = resolver.resolveRelationships(result.relationships);
      resolvedByFile.set(result.filePath, resolved);
    }

    return { fileEntities, resolvedByFile };
  }

  // Persist entities + relationships for a full scan. Entities are stored before
  // any relationship (graph upserts require both endpoints to exist).
  private async persistResolved(
    results: ParseResult[],
    fileEntities: Map<string, Entity>,
    resolvedByFile: Map<string, Relationship[]>,
    embeddings: Map<string, number[]>,
  ): Promise<{ entitiesStored: number; relationshipsStored: number }> {
    let entitiesStored = 0;
    let relationshipsStored = 0;

    for (const result of results) {
      const fileEntity = fileEntities.get(result.filePath)!;
      entitiesStored += await this.persistFileEntities(result, fileEntity, embeddings);
    }

    // Store relationships after all entity nodes exist (graph upserts require both endpoints)
    for (const result of results) {
      relationshipsStored += await this.persistFileRelationships(
        result,
        fileEntities.get(result.filePath)!,
        resolvedByFile.get(result.filePath)!
      );
    }

    return { entitiesStored, relationshipsStored };
  }

  private async persistFileEntities(
    result: ParseResult,
    fileEntity: Entity,
    embeddings: Map<string, number[]>,
  ): Promise<number> {
    // Populate domain / architecturalRole metadata
    applyDomainMetadata(result.entities, this.domainConfig || undefined);

    const entities = [...result.entities, fileEntity];

    // Store entities in both databases
    let stored = 0;
    for (const entity of entities) {
      try {
        await this.entityRepo.upsert(entity);
        await this.graphClient.upsertEntity(entity, this.config.repoPath);
        const embedding = embeddings.get(entity.stableId);
        if (embedding) {
          await this.entityRepo.updateEmbedding(entity.stableId, embedding);
        }
        stored++;
      } catch (error) {
        this.logger.error({ err: error, entity: entity.name, filePath: result.filePath }, 'Failed to store entity');
      }
    }
    metrics.inc('repo_memory_entities_scanned_total', undefined, stored);
    return stored;
  }

  private async persistFileRelationships(
    result: ParseResult,
    fileEntity: Entity,
    resolvedRelationships: Relationship[],
  ): Promise<number> {
    // Remove stale relationships for this file (e.g. previously unresolved targets)
    await this.relationshipRepo.deleteByFilePath(result.filePath);

    const rels: Relationship[] = resolvedRelationships.map(rel =>
      // EXPORTS / module-level IMPORTS use the raw file path as sourceId; re-anchor to the file entity
      rel.sourceId === result.filePath ? { ...rel, sourceId: fileEntity.stableId } : rel
    );

    // Structural containment: the file contains each top-level entity, so file
    // nodes connect to their symbols in the graph
    for (const entity of result.entities) {
      rels.push({
        id: `contains:${fileEntity.stableId}:${entity.stableId}`,
        sourceId: fileEntity.stableId,
        targetId: entity.stableId,
        type: RelationshipType.CONTAINS,
        filePath: result.filePath,
        line: entity.startLine,
        confidence: 1.0,
        createdAt: new Date(),
        updatedAt: new Date(),
      });
    }

    // Store relationships in both databases
    let stored = 0;
    for (const relationship of rels) {
      try {
        await this.relationshipRepo.upsert(relationship);
        await this.graphClient.upsertRelationship(relationship, this.config.repoPath);
        stored++;
      } catch (error) {
        this.logger.error({ err: error, filePath: result.filePath }, 'Failed to store relationship');
      }
    }
    metrics.inc('repo_memory_relationships_stored_total', undefined, stored);
    return stored;
  }

  private async handleFileDeletion(filePath: string): Promise<void> {
    this.logger.debug({ file: filePath }, 'Handling file deletion');

    // Remove entities from both databases
    const entities = await this.entityRepo.findByFilePath(filePath);
    for (const entity of entities) {
      await this.graphClient.deleteEntity(entity.stableId);
    }
    await this.entityRepo.deleteByFilePath(filePath);

    // Remove relationships
    await this.relationshipRepo.deleteByFilePath(filePath);
  }

  private async getSourceFiles(dir: string): Promise<string[]> {
    const fs = await import('fs/promises');
    const path = await import('path');

    const files: string[] = [];
    const entries = await fs.readdir(dir, { withFileTypes: true });

    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);

      if (entry.isDirectory()) {
        // Skip node_modules, .git, dist, etc.
        if (['node_modules', '.git', 'dist', 'build', '.next', 'coverage'].includes(entry.name)) {
          continue;
        }

        const subFiles = await this.getSourceFiles(fullPath);
        files.push(...subFiles);
      } else if (entry.isFile() && (shouldParseFile(entry.name) || isConfigFilePath(entry.name))) {
        files.push(fullPath);
      }
    }

    return files;
  }

  async getEntity(id: string): Promise<Entity | null> {
    return this.entityRepo.findById(id);
  }

  async getEntityByStableId(stableId: string): Promise<Entity | null> {
    return this.entityRepo.findByStableId(stableId);
  }

  async searchEntities(query: string): Promise<Entity[]> {
    return this.entityRepo.search(query);
  }

  async getDependencies(stableId: string): Promise<Entity[]> {
    const deps = await this.graphClient.findDependencies(stableId);
    return deps.map(d => d.entity);
  }

  async getDependents(stableId: string): Promise<Entity[]> {
    const deps = await this.graphClient.findDependents(stableId);
    return deps.map(d => d.entity);
  }

  async getTransitiveDependencies(stableId: string, maxDepth: number = 5): Promise<Entity[]> {
    return this.graphClient.findTransitiveDependencies(stableId, maxDepth);
  }

  async getDeadCodeReport(): Promise<DeadCodeReport> {
    return streamDeadCode(
      { page: (offset, limit) => this.entityRepo.findAll(limit, offset) },
      {
        page: (offset, limit) =>
          this.relationshipRepo.findByTypesPaged(
            [
              RelationshipType.CALLS,
              RelationshipType.REFERENCES,
              RelationshipType.IMPORTS,
              RelationshipType.EXTENDS,
              RelationshipType.IMPLEMENTS,
            ],
            limit,
            offset
          ),
      }
    );
  }

  async getBoundariesReport(): Promise<BoundaryReport> {
    const config = await this.loadDomainConfig();
    return streamBoundaries(
      { page: (offset, limit) => this.entityRepo.findAll(limit, offset) },
      {
        page: (offset, limit) =>
          this.relationshipRepo.findByTypesPaged(
            [
              RelationshipType.IMPORTS,
              RelationshipType.CALLS,
              RelationshipType.REFERENCES,
              RelationshipType.EXTENDS,
              RelationshipType.IMPLEMENTS,
            ],
            limit,
            offset
          ),
      },
      config ?? undefined
    );
  }

  // Dominant author per file, computed from recent commit history.
  async getOwnership(limit: number = 500): Promise<Array<{ filePath: string; owner: string; commits: number }>> {
    const commits = await this.commitRepo.findRecent(limit);
    const byFile = new Map<string, Map<string, number>>();

    for (const commit of commits) {
      for (const file of commit.filesChanged) {
        let authors = byFile.get(file);
        if (!authors) {
          authors = new Map();
          byFile.set(file, authors);
        }
        authors.set(commit.author, (authors.get(commit.author) || 0) + 1);
      }
    }

    const result: Array<{ filePath: string; owner: string; commits: number }> = [];
    for (const [filePath, authors] of byFile) {
      let owner = 'unknown';
      let max = 0;
      for (const [author, count] of authors) {
        if (count > max) {
          max = count;
          owner = author;
        }
      }
      result.push({ filePath, owner, commits: max });
    }

    return result.sort((a, b) => a.filePath.localeCompare(b.filePath));
  }

  private getChangeAnalyzer(): ChangeAnalyzer {
    if (!this.changeAnalyzer) {
      this.changeAnalyzer = new ChangeAnalyzer({
        fileChurnRows: (repoPath, days) => this.commitRepo.getFileChurn(repoPath, 100000, days),
        entityPage: (repoPath, offset, limit) => this.entityRepo.findAll(limit, offset),
        relationshipPage: (repoPath, offset, limit) =>
          this.relationshipRepo.findByTypesPaged(
            [
              RelationshipType.CALLS,
              RelationshipType.REFERENCES,
              RelationshipType.IMPORTS,
              RelationshipType.EXTENDS,
              RelationshipType.IMPLEMENTS,
              RelationshipType.HANDLES,
            ],
            limit,
            offset
          ),
        entityByStableId: (repoPath, stableId) => this.entityRepo.findByStableId(stableId),
        entities: async () => {
          const all: Entity[] = [];
          const limit = resolveBatchSize();
          let offset = 0;
          while (true) {
            const batch = await this.entityRepo.findAll(limit, offset);
            all.push(...batch);
            if (batch.length < limit) break;
            offset += limit;
          }
          return all;
        },
        relationships: async () => {
          const all: Relationship[] = [];
          const limit = resolveBatchSize();
          let offset = 0;
          while (true) {
            const batch = await this.relationshipRepo.findByTypesPaged(
              [
                RelationshipType.CALLS,
                RelationshipType.REFERENCES,
                RelationshipType.IMPORTS,
                RelationshipType.EXTENDS,
                RelationshipType.IMPLEMENTS,
                RelationshipType.HANDLES,
              ],
              limit,
              offset
            );
            all.push(...batch);
            if (batch.length < limit) break;
            offset += limit;
          }
          return all;
        },
        lastCommitDate: (repoPath) => this.commitRepo.getLastCommitDate(repoPath),
      });
    }
    return this.changeAnalyzer;
  }

  async getChurn(limit: number = 50, days?: number) {
    return this.getChangeAnalyzer().computeFileChurn(this.config.repoPath, limit, days);
  }

  async getFileRisk(limit: number = 100) {
    const all = await this.getChangeAnalyzer().computeFileRisk(this.config.repoPath);
    return all.slice(0, limit);
  }

  async getRisk(stableId: string) {
    return this.getChangeAnalyzer().computeEntityChange(this.config.repoPath, stableId);
  }

  async getDrift() {
    return this.getChangeAnalyzer().detectDrift(this.config.repoPath);
  }

  // --- Reconciliation & repair jobs (5.4) ----------------------------------

  // Enqueue + run a reconciliation job against the given repo (defaults to this
  // orchestrator's repo). Persists status/result/error to the `jobs` table and
  // keeps the queue-depth metric in sync.
  async runJob(type: JobType, repoPath?: string): Promise<Job> {
    const targetRepo = repoPath || this.config.repoPath;
    this.logger.info({ jobType: type, repoPath: targetRepo }, 'Starting job');

    const job = await this.jobRepo.create({ type, repositoryPath: targetRepo });
    await this.refreshQueueDepth();

    try {
      await this.jobRepo.markRunning(job.id);
      const startedAt = performance.now();
      const result = type === 'verify'
        ? await this.verifyRepo(targetRepo)
        : await this.repairRepo(targetRepo);
      const durationMs = Math.round(performance.now() - startedAt);

      await this.jobRepo.markCompleted(job.id, result);
      await this.refreshQueueDepth();
      this.logger.info({ jobId: job.id, jobType: type, repoPath: targetRepo, durationMs, status: 'completed' }, 'Job completed');

      const completed = await this.jobRepo.findById(job.id);
      if (!completed) throw new Error(`Job ${job.id} not found after completion`);
      return completed;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await this.jobRepo.markFailed(job.id, message);
      await this.refreshQueueDepth();
      this.logger.error({ err: error, jobId: job.id, jobType: type, repoPath: targetRepo }, 'Job failed');
      throw error;
    }
  }

  async listScannedRepos(): Promise<string[]> {
    const result = await this.pgPool.query(
      `SELECT DISTINCT repo_path FROM entities WHERE repo_path <> '' ORDER BY repo_path`
    );
    return result.rows.map((row) => row.repo_path);
  }

  private async refreshQueueDepth(): Promise<void> {
    try {
      const depth = await this.jobRepo.countActive();
      metrics.set('repo_memory_queue_depth', depth);
    } catch (error) {
      this.logger.error({ err: error }, 'Failed to refresh queue depth metric');
    }
  }

  // Compare PostgreSQL (source of truth) against Neo4j: per-type entity and
  // relationship counts, orphan nodes/edges on either side, and entities whose
  // embedding is missing.
  private async verifyRepo(repoPath: string): Promise<VerificationReport> {
    const entityRepo = new EntityRepository(this.pgPool, repoPath);
    const relationshipRepo = new RelationshipRepository(this.pgPool, repoPath);

    const pgEntityCounts = await entityRepo.countByType();
    const graphEntityCounts = await this.graphClient.countEntitiesByType(repoPath);

    const pgIds = new Set(await entityRepo.findAllStableIds());
    const graphIds = await this.graphClient.listEntityStableIds(repoPath);
    const uniqueGraphIds = new Set(graphIds);
    const duplicateGraphNodes = graphIds.length - uniqueGraphIds.size;
    const missingInGraph = [...pgIds].filter(id => !uniqueGraphIds.has(id)).sort();
    const orphanGraphNodes = [...uniqueGraphIds].filter(id => !pgIds.has(id)).sort();

    const pgRelCounts = await relationshipRepo.countByType();
    const graphRelCounts = await this.graphClient.countRelationshipsByType(repoPath);

    // A PG relationship is only *representable* in the graph when both of its
    // endpoint stable IDs are real entities (some PG rows reference unresolved
    // expression text as targetId, which cannot be a graph node). Reconciliation
    // targets the representable subset; the raw per-type counts stay available
    // for the surface breakdown.
    const pgRelKeys = (await relationshipRepo.findAllKeys())
      .filter(k => pgIds.has(k.sourceId) && pgIds.has(k.targetId))
      .map(relationshipKey);
    const graphRelKeys = new Set((await this.graphClient.listRelationshipKeys(repoPath)).map(relationshipKey));
    const missingRelationships = [...pgRelKeys].filter(key => !graphRelKeys.has(key)).sort();
    const orphanRelationships = [...graphRelKeys].filter(key => !pgRelKeys.includes(key)).sort();

    const entitiesWithoutEmbedding = await entityRepo.countWithoutEmbedding();

    const entityCounts = this.mergeTypeCounts(pgEntityCounts, graphEntityCounts);
    const relationshipCounts = this.mergeTypeCounts(pgRelCounts, graphRelCounts);
    const entityTotal = { pg: pgIds.size, graph: uniqueGraphIds.size, delta: pgIds.size - uniqueGraphIds.size };
    const relationshipTotal = { pg: pgRelKeys.length, graph: graphRelKeys.size, delta: pgRelKeys.length - graphRelKeys.size };

    const report: VerificationReport = {
      repoPath,
      ranAt: new Date().toISOString(),
      entityCounts,
      relationshipCounts,
      entityTotal,
      relationshipTotal,
      duplicateGraphNodes,
      missingInGraph,
      orphanGraphNodes,
      missingRelationshipCount: missingRelationships.length,
      missingRelationships,
      orphanRelationshipCount: orphanRelationships.length,
      orphanRelationships,
      entitiesWithoutEmbedding,
      ok: missingInGraph.length === 0 && orphanGraphNodes.length === 0
        && missingRelationships.length === 0 && orphanRelationships.length === 0,
    };

    this.logger.info(
      { repoPath, entityDelta: report.entityTotal.delta, relationshipDelta: report.relationshipTotal.delta,
        missingInGraph: missingInGraph.length, orphanNodes: orphanGraphNodes.length, entitiesWithoutEmbedding },
      'Verification report produced'
    );
    return report;
  }

  // Re-sync Neo4j from PostgreSQL: upsert entities and relationships that are
  // missing from the graph, delete orphan graph nodes/edges, and re-embed any
  // entities that have no embedding.
  private async repairRepo(repoPath: string): Promise<RepairReport> {
    const entityRepo = new EntityRepository(this.pgPool, repoPath);
    const relationshipRepo = new RelationshipRepository(this.pgPool, repoPath);

    let entitiesUpserted = 0;
    let relationshipsUpserted = 0;
    let orphanNodesDeleted = 0;
    let orphanRelationshipsDeleted = 0;
    let embeddingsGenerated = 0;

    // Entities missing from the graph get upserted from PG (source of truth).
    const pgIds = new Set(await entityRepo.findAllStableIds());
    const graphIds = new Set(await this.graphClient.listEntityStableIds(repoPath));
    const missingInGraph = [...pgIds].filter(id => !graphIds.has(id));
    const missingSet = new Set(missingInGraph);

    const pageLimit = 500;
    let offset = 0;
    while (true) {
      const batch = await entityRepo.findAll(pageLimit, offset);
      if (batch.length === 0) break;
      for (const entity of batch) {
        if (!missingSet.has(entity.stableId)) continue;
        await this.graphClient.upsertEntity(entity, repoPath);
        entitiesUpserted++;
      }
      if (batch.length < pageLimit) break;
      offset += pageLimit;
    }

    // Orphan graph nodes (no PG row) are deleted along with their edges.
    for (const stableId of graphIds) {
      if (pgIds.has(stableId)) continue;
      await this.graphClient.deleteEntity(stableId);
      orphanNodesDeleted++;
    }

    // Relationships missing from the graph get upserted. Endpoints are
    // guaranteed present after the entity pass above; only relationships whose
    // PG endpoint IDs are real entities are representable in the graph.
    const pgRelKeys = new Map<string, { sourceId: string; targetId: string; type: string; filePath: string }>();
    for (const key of await relationshipRepo.findAllKeys()) {
      if (!pgIds.has(key.sourceId) || !pgIds.has(key.targetId)) continue;
      pgRelKeys.set(relationshipKey(key), key);
    }
    const graphRelKeys = new Map<string, { sourceId: string; targetId: string; type: string; filePath: string }>();
    for (const key of await this.graphClient.listRelationshipKeys(repoPath)) {
      graphRelKeys.set(relationshipKey(key), key);
    }
    const missingRelKeys = [...pgRelKeys.keys()].filter(key => !graphRelKeys.has(key));

    if (missingRelKeys.length > 0) {
      const missingRelSet = new Set(missingRelKeys);
      let relOffset = 0;
      while (true) {
        const batch = await relationshipRepo.findAll(pageLimit, relOffset);
        if (batch.length === 0) break;
        for (const rel of batch) {
          if (!missingRelSet.has(relationshipKey(rel))) continue;
          await this.graphClient.upsertRelationship(rel, repoPath);
          relationshipsUpserted++;
        }
        if (batch.length < pageLimit) break;
        relOffset += pageLimit;
      }
    }

    // Orphan graph relationships: edges whose key has no PG counterpart. Orphan
    // nodes were already deleted above (DETACH DELETE), so this only removes
    // surplus edges between entities that still exist in PG.
    for (const [key, rel] of graphRelKeys) {
      if (pgRelKeys.has(key)) continue;
      await this.graphClient.deleteRelationship(rel.sourceId, rel.targetId, rel.type, rel.filePath);
      orphanRelationshipsDeleted++;
    }

    // Re-embed entities with null embeddings.
    let embedOffset = 0;
    while (true) {
      const batch = await entityRepo.findWithoutEmbedding(pageLimit, embedOffset);
      if (batch.length === 0) break;
      for (const entity of batch) {
        try {
          const embedding = await generateEntityEmbedding(entity.name, entity.type, entity.filePath);
          await entityRepo.updateEmbedding(entity.stableId, embedding);
          embeddingsGenerated++;
        } catch (error) {
          this.logger.error({ err: error, entity: entity.name }, 'Failed to re-embed entity during repair');
        }
      }
      if (batch.length < pageLimit) break;
      embedOffset += pageLimit;
    }

    this.logger.info(
      { repoPath, entitiesUpserted, relationshipsUpserted, orphanNodesDeleted, orphanRelationshipsDeleted, embeddingsGenerated },
      'Repair completed'
    );

    const verifyAfter = await this.verifyRepo(repoPath);
    return {
      repoPath,
      ranAt: new Date().toISOString(),
      entitiesUpserted,
      relationshipsUpserted,
      orphanNodesDeleted,
      orphanRelationshipsDeleted,
      embeddingsGenerated,
      verifyAfter,
    };
  }

  // Merge per-type counts from both stores into a single delta table.
  private mergeTypeCounts(
    pg: Array<{ type: string; count: number }>,
    graph: Array<{ type: string; count: number }>,
  ): TypeCountDelta[] {
    const byType = new Map<string, { pgCount: number; graphCount: number }>();
    for (const row of pg) {
      byType.set(row.type, { pgCount: row.count, graphCount: 0 });
    }
    for (const row of graph) {
      const existing = byType.get(row.type);
      if (existing) {
        existing.graphCount = row.count;
      } else {
        byType.set(row.type, { pgCount: 0, graphCount: row.count });
      }
    }
    return [...byType.entries()]
      .map(([type, counts]) => ({
        type,
        pgCount: counts.pgCount,
        graphCount: counts.graphCount,
        delta: counts.pgCount - counts.graphCount,
      }))
      .sort((a, b) => a.type.localeCompare(b.type));
  }

  async close(): Promise<void> {
    await this.graphClient.close();
    await this.pgPool.end();
  }
}

// Canonical key for a relationship in both stores (matches the repo-scoped
// unique constraint on source_id, target_id, type, file_path).
function relationshipKey(rel: { sourceId: string; targetId: string; type: string; filePath: string }): string {
  return `${rel.sourceId}|${rel.targetId}|${rel.type}|${rel.filePath}`;
}
