import { Pool, PoolClient } from 'pg';
import { GraphClient } from '@repo-memory/graph';
import { EntityRepository, RelationshipRepository, CommitRepository, JobRepository, migrate, createPool } from '@repo-memory/storage';
import { GitOperations, FileWatcher } from '@repo-memory/ingestion';
import {
  TreeSitterParser, getGrammarKeyFromFilePath, languageFromGrammarKey,
  shouldParseFile, isConfigFilePath,
  configureEmbeddings, initializeEmbeddings, generateEntityEmbedding, generateEntityEmbeddings, getProviderName,
  SymbolIndex, RelationshipResolver, createFileEntity,
  applyDomainMetadata, parseDomainConfig, ChangeAnalyzer,
  streamDeadCode, streamBoundaries, resolveBatchSize
} from '@repo-memory/analysis';
import type { EmbeddingConfig, DeadCodeReport, DomainConfig, BoundaryReport } from '@repo-memory/analysis';
import { RelationshipType, getLogger, metrics, registerDefaultMetrics } from '@repo-memory/shared';
import type { Logger } from '@repo-memory/shared';
import type { Entity, Relationship, ParseResult, ScanReport, ScanPhaseReport, ScanType, Job, JobType, VerificationReport, RepairReport, TypeCountDelta, RepoStatus, FileChange } from '@repo-memory/shared';
import { readFileSync } from 'fs';
import { join, relative } from 'path';

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

// Directories that are never source code (vendored deps, virtualenvs, build
// output, caches). Recursively skipped during file discovery. Keeping this
// list broad prevents whole repositories (e.g. a Python .venv with tens of
// thousands of .py files) from being parsed as project source.
const SKIPPED_DIRECTORIES = new Set([
  'node_modules',
  '.git',
  'dist',
  'build',
  'out',
  '.next',
  'coverage',
  '.venv',
  'venv',
  '.tox',
  '__pycache__',
  '.pytest_cache',
  '.mypy_cache',
  '.ruff_cache',
  '.eggs',
  'site-packages',
  '.idea',
  '.vscode',
  '.turbo',
  '.cache',
]);

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
  private parserCache: Map<string, TreeSitterParser> = new Map();
  private domainConfig: DomainConfig | null = null;
  private changeAnalyzer: ChangeAnalyzer | null = null;
  private scanState: ScanState | null = null;
  private watcher: FileWatcher | null = null;
  private watchQueue: Array<{ filePath: string; status: string }> = [];
  private watchDebounceMs = 500;
  private watchTimer: NodeJS.Timeout | null = null;
  private watchProcessing = false;
  private lastWatchScanAt: Date | null = null;
  // Persisted across watch flush windows so edits don't reload the whole
  // database symbol index on every debounce.
  private watchIndex: SymbolIndex | null = null;

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
      // Eagerly load the model (e.g. ONNX download) so the first scan isn't
      // stalled by model initialization on its first embed call.
      await initializeEmbeddings();
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
    const supportedGrammarKeys = ['typescript', 'tsx', 'javascript', 'python'];

    for (const grammarKey of supportedGrammarKeys) {
      const parser = new TreeSitterParser(languageFromGrammarKey(grammarKey), grammarKey);
      await parser.initialize();
      this.parserCache.set(grammarKey, parser);
      this.logger.debug({ grammarKey }, 'Initialized parser');
    }
  }

  private async getParser(grammarKey: string): Promise<TreeSitterParser> {
    let parser = this.parserCache.get(grammarKey);
    if (!parser) {
      parser = new TreeSitterParser(languageFromGrammarKey(grammarKey), grammarKey);
      await parser.initialize();
      this.parserCache.set(grammarKey, parser);
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

    // Fresh full scan: replace this repo's data atomically. Parse/resolve/embed
    // must succeed before the destructive step (delete + re-insert) runs; that
    // happens inside one PostgreSQL transaction so a mid-persist failure rolls
    // back to the previous snapshot. The graph is cleared first (it can't join
    // the transaction); graph upserts inside the transaction rebuild it, and any
    // residual Neo4j gaps are reconciled by the repair job.
    //
    // Memory stays bounded regardless of repo size: files are processed in
    // windows. Entities + their CONTAINS edges are persisted as each window is
    // parsed (both endpoints of a CONTAINS edge live in the same file), so the
    // heavy per-file data (entities, embeddings) is freed between windows. Only
    // the lightweight raw relationships are buffered across windows, because
    // cross-file resolution requires the complete repo symbol index and Neo4j
    // relationship upserts require both endpoint nodes to already exist.
    await this.graphClient.deleteAll(this.config.repoPath);
    const client = await this.pgPool.connect();
    let entitiesStored = 0;
    let relationshipsStored = 0;
    try {
      await client.query('BEGIN');
      await this.entityRepo.deleteAll(client);
      await this.relationshipRepo.deleteAll(client);

      // Repo-wide symbol index built incrementally across all windows.
      const index = new SymbolIndex(this.config.repoPath);
      const resolver = new RelationshipResolver(index, this.config.repoPath);
      // Raw relationships buffered until the whole repo is indexed; keyed by
      // file path so the resolver can look up each file's entities.
      const pendingRelationships = new Map<string, Relationship[]>();

      const WINDOW = 500;
      let filesParsed = 0;
      let entityCount = 0;
      let relCount = 0;
      let embedCount = 0;
      let parseMs = 0;
      let embedMs = 0;
      let resolveMs = 0;

      for (let i = 0; i < files.length; i += WINDOW) {
        const window = files.slice(i, i + WINDOW);

        // Parse this window.
        const results: ParseResult[] = [];
        for (const file of window) {
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

        // Register window entities + imports into the repo-wide symbol index.
        for (const result of results) {
          index.addFile(result.filePath);
          index.addEntity(createFileEntity(result.filePath, this.config.repoPath));
          index.addEntities(result.entities);
        }
        for (const result of results) {
          index.registerRelationships(result.relationships);
        }

        // Embed + persist this window's entities and their CONTAINS edges.
        const embeddings = new Map<string, number[]>();
        for (const result of results) {
          const embedStart = performance.now();
          const embs = await this.generateEmbeddings(result);
          embedMs += performance.now() - embedStart;
          embedCount += embs.size;
          embs.forEach((embedding, stableId) => embeddings.set(stableId, embedding));
        }

        for (const result of results) {
          const fileEntity = createFileEntity(result.filePath, this.config.repoPath);
          entitiesStored += await this.persistFileEntities(result, fileEntity, embeddings, client);
          // CONTAINS edges reference only same-file entities, so they can be
          // persisted now; other relationships wait for the full index.
          const containsEdges = result.entities.map((entity) => ({
            id: `contains:${fileEntity.stableId}:${entity.stableId}`,
            sourceId: fileEntity.stableId,
            targetId: entity.stableId,
            type: RelationshipType.CONTAINS,
            filePath: result.filePath,
            line: entity.startLine,
            confidence: 1.0,
            createdAt: new Date(),
            updatedAt: new Date(),
          }));
          relationshipsStored += await this.persistRelationships(containsEdges, client);
        }

        // Keep raw relationships so they can be resolved against the full index.
        for (const result of results) {
          pendingRelationships.set(result.filePath, result.relationships);
        }
      }

      // Resolve + persist every file's relationships against the now-complete
      // index. All entity nodes already exist in both stores (entities are
      // persisted per-window; Neo4j relationships are written after the final
      // window so their endpoints always exist).
      const resolveStart = performance.now();
      for (const [filePath, relationships] of pendingRelationships) {
        const fileEntity = createFileEntity(filePath, this.config.repoPath);
        const resolved = resolver.resolveRelationships(relationships).map((rel) =>
          // EXPORTS / module-level IMPORTS use the raw file path as sourceId;
          // re-anchor to the file entity.
          rel.sourceId === filePath ? { ...rel, sourceId: fileEntity.stableId } : rel
        );
        relationshipsStored += await this.persistRelationships(resolved, client);
      }
      resolveMs = performance.now() - resolveStart;

      await client.query('COMMIT');

      this.endPhase('discover', 0, 0, discoverMs);
      this.endPhase('parse', entityCount, relCount, parseMs);
      this.endPhase('resolve', 0, relCount, resolveMs);
      this.endPhase('embed', embedCount, 0, embedMs);
      this.endPhase('persist', entitiesStored, relationshipsStored);

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
    } catch (error) {
      await client.query('ROLLBACK');
      this.logger.error({ err: error }, 'Full scan persist failed; transaction rolled back');
      throw error;
    } finally {
      client.release();
    }
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

      // Bulk update instead of one query per file (large repos touch thousands).
      const firstKeys = [...firstSeen.keys()];
      if (firstKeys.length > 0) {
        await this.pgPool.query(
          `UPDATE entities
           SET first_seen_commit = src.hash, updated_at = NOW()
           FROM (SELECT unnest($1::text[]) AS file_key, unnest($2::text[]) AS hash) AS src
           WHERE entities.repo_path = $3
             AND REPLACE(entities.file_path, '\\', '/') = src.file_key
             AND entities.first_seen_commit IS NULL`,
          [firstKeys, firstKeys.map((k) => firstSeen.get(k)!), this.config.repoPath]
        );
      }
      const lastKeys = [...lastSeen.keys()];
      if (lastKeys.length > 0) {
        await this.pgPool.query(
          `UPDATE entities
           SET last_seen_commit = src.hash, updated_at = NOW()
           FROM (SELECT unnest($1::text[]) AS file_key, unnest($2::text[]) AS hash) AS src
           WHERE entities.repo_path = $3
             AND REPLACE(entities.file_path, '\\', '/') = src.file_key`,
          [lastKeys, lastKeys.map((k) => lastSeen.get(k)!), this.config.repoPath]
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

  // --- Live file watching (5.6) ---------------------------------------------
  //
  // Watches the working tree with chokidar (via FileWatcher) and replays each
  // file:change / file:add / file:delete through the same incremental-scan path
  // (processChanges single-file path / handleFileDeletion). Events are queued
  // and flushed on a debounce window so a burst of edits coalesces into one
  // incremental scan.

  async startWatching(options: { debounceMs?: number } = {}): Promise<void> {
    if (this.watcher) return;
    this.watchDebounceMs = options.debounceMs ?? 500;
    this.lastWatchScanAt = null;
    this.watchIndex = null;

    this.watcher = new FileWatcher(this.config.repoPath, { ignoreInitial: true });
    this.watcher.on('file:change', (change) => this.queueWatchChange(change));
    this.watcher.on('file:add', (change) => this.queueWatchChange(change));
    this.watcher.on('file:delete', (change) => this.queueWatchChange(change));
    this.watcher.on('error', (err) => this.logger.error({ err }, 'File watcher error'));
    this.watcher.start();

    this.logger.info({ repoPath: this.config.repoPath, debounceMs: this.watchDebounceMs }, 'Watching repository for changes');
  }

  async stopWatching(): Promise<void> {
    if (this.watchTimer) {
      clearTimeout(this.watchTimer);
      this.watchTimer = null;
    }
    this.watchIndex = null;
    if (this.watcher) {
      await this.watcher.stop();
      this.watcher = null;
    }
    this.logger.info('Stopped watching repository');
  }

  private queueWatchChange(change: FileChange): void {
    // Normalize to forward slashes so watcher paths match the git-derived
    // relative paths stored in the database on all platforms.
    const normalize = (p: string): string => p.replace(/\\/g, '/');
    if (change.status === 'renamed') {
      // A rename is a delete of the old path plus an add of the new path.
      if (change.oldPath) {
        this.watchQueue.push({ filePath: normalize(change.oldPath), status: 'deleted' });
      }
      this.watchQueue.push({ filePath: normalize(change.filePath), status: 'added' });
    } else {
      this.watchQueue.push({ filePath: normalize(change.filePath), status: change.status });
    }

    if (!this.watchTimer) {
      this.watchTimer = setTimeout(() => {
        this.watchTimer = null;
        void this.flushWatchQueue();
      }, this.watchDebounceMs);
    }
  }

  private async flushWatchQueue(): Promise<void> {
    if (this.watchProcessing) return;
    if (this.watchQueue.length === 0) return;

    this.watchProcessing = true;
    const changes = this.watchQueue;
    this.watchQueue = [];
    try {
      this.logger.info({ files: changes.length }, 'Applying watched file changes');
      const report = await this.processWatchChanges(changes);
      this.lastWatchScanAt = new Date();
      this.logger.info(
        { files: changes.length, entitiesStored: report.entitiesStored, relationshipsStored: report.relationshipsStored, durationMs: report.totalDurationMs },
        'Watched changes applied'
      );
    } catch (error) {
      this.logger.error({ err: error, files: changes.map(c => c.filePath) }, 'Failed to apply watched changes');
    } finally {
      this.watchProcessing = false;
      // Re-schedule if new changes arrived while we were processing.
      if (this.watchQueue.length > 0) {
        this.watchTimer = setTimeout(() => {
          this.watchTimer = null;
          void this.flushWatchQueue();
        }, this.watchDebounceMs);
      }
    }
  }

  // Runs the incremental single-file path for a set of watched changes without
  // recording a new commit (the working tree is not a commit).
  private async processWatchChanges(changes: Array<{ filePath: string; status: string }>): Promise<ScanReport> {
    this.beginScan('working-tree');
    // Reuse the in-memory symbol index across flush windows instead of
    // reloading the whole database on every edit. Rebuild only on the first
    // flush or when a deletion occurred (SymbolIndex has no remove path).
    if (!this.watchIndex || changes.some((c) => c.status === 'deleted')) {
      this.watchIndex = await this.loadSymbolIndex();
    }
    const stats = await this.processChanges(changes, this.watchIndex);
    await this.touchRepoState();
    return this.finishScan(
      changes.length,
      stats.filesParsed,
      stats.entitiesExtracted,
      stats.relationshipsExtracted,
      stats.embeddingsGenerated,
      stats.entitiesStored,
      stats.relationshipsStored,
    );
  }

  // Record that a watch-driven scan happened (no commit hash involved) so
  // `GET /api/status` reflects live edits.
  private async touchRepoState(): Promise<void> {
    try {
      await this.pgPool.query(
        `INSERT INTO repo_state (repo_path, last_scan_at)
         VALUES ($1, NOW())
         ON CONFLICT (repo_path) DO UPDATE SET last_scan_at = NOW()`,
        [this.config.repoPath]
      );
    } catch (error) {
      this.logger.error({ err: error }, 'Failed to update watch scan time');
    }
  }

  // Live watch status for the API/frontend. Falls back to the last commit-based
  // scan timestamp when no watch-driven scan has happened yet.
  async getStatus(): Promise<RepoStatus> {
    let lastScanAt: string | null = null;
    try {
      const result = await this.pgPool.query(
        'SELECT last_scan_at FROM repo_state WHERE repo_path = $1',
        [this.config.repoPath]
      );
      if (result.rows[0]?.last_scan_at) {
        lastScanAt = new Date(result.rows[0].last_scan_at).toISOString();
      }
    } catch {
      // Ignore — fall back to the in-memory watch timestamp.
    }
    return {
      repoPath: this.config.repoPath,
      watching: this.watcher !== null,
      lastScanAt: lastScanAt ?? (this.lastWatchScanAt ? this.lastWatchScanAt.toISOString() : null),
      pendingChanges: this.watchQueue.length,
    };
  }

  // True when the repo already has stored entity data (used by `watch` to decide
  // whether to run an initial full scan before watching).
  async hasStoredData(): Promise<boolean> {
    try {
      const count = await this.entityRepo.count();
      return count > 0;
    } catch (error) {
      this.logger.error({ err: error }, 'Failed to check for stored data');
      return false;
    }
  }

  // Parse, resolve, and persist a batch of changed files. For incremental scans the
  // repo-wide symbol index is loaded from the database so relationships still resolve
  // against definitions in files that were not re-parsed. Records per-phase telemetry
  // into the active scan state.
  private async processChanges(
    changes: Array<{ filePath: string; status: string }>,
    indexParam?: SymbolIndex,
  ): Promise<ProcessStats> {
    let parseMs = 0;
    let embedMs = 0;
    let filesParsed = 0;
    let entityCount = 0;
    let relCount = 0;
    let embedCount = 0;

    const resolveStart = performance.now();
    const index = indexParam ?? await this.loadSymbolIndex();
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

    const relativePath = relative(this.config.repoPath, filePath).replace(/\\/g, '/');

    // Read file content
    let content: string;
    try {
      content = readFileSync(filePath, 'utf-8');
    } catch (error) {
      this.logger.error({ err: error, file: filePath }, 'Failed to read file');
      return null;
    }

    // Parse file using cached parser (grammar keyed so .tsx uses the JSX grammar)
    const grammarKey = getGrammarKeyFromFilePath(filePath);
    const parser = await this.getParser(grammarKey);

    const result = await parser.parse(relativePath, content, this.config.repoPath);

    this.logger.debug(
      { file: relativePath, entityCount: result.entities.length, relationshipCount: result.relationships.length },
      'Parsed file'
    );
    return result;
  }

  private async generateEmbeddings(result: ParseResult): Promise<Map<string, number[]>> {
    const embeddings = new Map<string, number[]>();
    if (result.entities.length === 0) return embeddings;
    try {
      const vectors = await generateEntityEmbeddings(
        result.entities.map((entity) => ({
          name: entity.name,
          type: entity.type,
          filePath: entity.filePath,
        }))
      );
      result.entities.forEach((entity, i) => {
        if (vectors[i]) embeddings.set(entity.stableId, vectors[i]);
      });
    } catch (error) {
      this.logger.error({ err: error, file: result.filePath }, 'Failed to generate embeddings');
    }
    return embeddings;
  }

  // Build the symbol index and resolve every file's relationships against it.
  // Split from persistence so scans can time the resolve phase independently.
  // (Full scans build the index incrementally across parse windows instead.)

  // Persist entities + relationships for a full scan. Entities are stored before
  // any relationship (graph upserts require both endpoints to exist). Full scans
  // persist per-window instead of buffering the whole repo.

  // Store a batch of relationships in both databases. Used by the full scan to
  // persist CONTAINS edges per-window and resolved relationships once the whole
  // repo symbol index is built; the incremental path uses persistFileRelationships
  // (which additionally cleans up stale rows for the file).
  private async persistRelationships(
    relationships: Relationship[],
    client?: PoolClient,
  ): Promise<number> {
    let stored = 0;
    for (const relationship of relationships) {
      try {
        await this.relationshipRepo.upsert(relationship, client);
        await this.graphClient.upsertRelationship(relationship, this.config.repoPath);
        stored++;
      } catch (error) {
        this.logger.error({ err: error, filePath: relationship.filePath }, 'Failed to store relationship');
      }
    }
    metrics.inc('repo_memory_relationships_stored_total', undefined, stored);
    return stored;
  }

  private async persistFileEntities(
    result: ParseResult,
    fileEntity: Entity,
    embeddings: Map<string, number[]>,
    client?: PoolClient,
  ): Promise<number> {
    // Populate domain / architecturalRole metadata
    applyDomainMetadata(result.entities, this.domainConfig || undefined);

    const entities = [...result.entities, fileEntity];

    // Store entities in both databases
    let stored = 0;
    for (const entity of entities) {
      try {
        await this.entityRepo.upsert(entity, client);
        await this.graphClient.upsertEntity(entity, this.config.repoPath);
        const embedding = embeddings.get(entity.stableId);
        if (embedding) {
          await this.entityRepo.updateEmbedding(entity.stableId, embedding, client);
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
    client?: PoolClient,
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
        await this.relationshipRepo.upsert(relationship, client);
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
        // Skip vendored dependencies, virtualenvs, build output, and caches.
        if (SKIPPED_DIRECTORIES.has(entry.name)) {
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
    const deps = await this.graphClient.findDependencies(stableId, this.config.repoPath);
    return deps.map(d => d.entity);
  }

  async getDependents(stableId: string): Promise<Entity[]> {
    const deps = await this.graphClient.findDependents(stableId, this.config.repoPath);
    return deps.map(d => d.entity);
  }

  async getTransitiveDependencies(stableId: string, maxDepth: number = 5): Promise<Entity[]> {
    return this.graphClient.findTransitiveDependencies(stableId, maxDepth, this.config.repoPath);
  }

  async getTransitiveDependents(stableId: string, maxDepth: number = 5): Promise<Entity[]> {
    return this.graphClient.findTransitiveDependents(stableId, maxDepth, this.config.repoPath);
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
    await this.stopWatching();
    await this.graphClient.close();
    await this.pgPool.end();
  }
}

// Canonical key for a relationship in both stores (matches the repo-scoped
// unique constraint on source_id, target_id, type, file_path).
function relationshipKey(rel: { sourceId: string; targetId: string; type: string; filePath: string }): string {
  return `${rel.sourceId}|${rel.targetId}|${rel.type}|${rel.filePath}`;
}
