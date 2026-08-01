import { Pool } from 'pg';
import { GraphClient } from '@repo-memory/graph';
import { EntityRepository, RelationshipRepository, CommitRepository, migrate, createPool } from '@repo-memory/storage';
import { GitOperations } from '@repo-memory/ingestion';
import {
  TreeSitterParser, getLanguageFromFilePath, shouldParseFile, isConfigFilePath,
  configureEmbeddings, generateEntityEmbedding, getProviderName,
  SymbolIndex, RelationshipResolver, createFileEntity, detectDeadCode,
  applyDomainMetadata, parseDomainConfig
} from '@repo-memory/analysis';
import type { EmbeddingConfig, DeadCodeReport, DomainConfig } from '@repo-memory/analysis';
import { Language, RelationshipType } from '@repo-memory/shared';
import { Entity, Relationship, FileChange, ParseResult } from '@repo-memory/shared';
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

export class Orchestrator {
  private graphClient: GraphClient;
  private pgPool!: Pool;
  private entityRepo!: EntityRepository;
  private relationshipRepo!: RelationshipRepository;
  private commitRepo!: CommitRepository;
  private gitOps: GitOperations;
  private config: OrchestratorConfig;
  private parserCache: Map<Language, TreeSitterParser> = new Map();
  private domainConfig: DomainConfig | null = null;

  constructor(config: OrchestratorConfig) {
    this.config = config;
    this.graphClient = new GraphClient(
      config.neo4jUri,
      config.neo4jUser,
      config.neo4jPassword
    );
    this.gitOps = new GitOperations(config.repoPath);
  }

  async initialize(): Promise<void> {
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
    console.log('Initializing Repository Memory Engine...');
    
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
      console.log(`Embeddings initialized with ${getProviderName()} provider.`);
    }

    // Pre-initialize parsers for supported languages
    await this.initializeParsers();

    // Load optional boundary/domain config
    this.domainConfig = this.loadDomainConfig();

    console.log('Initialization complete.');
  }

  private loadDomainConfig(): DomainConfig | null {
    const configPath = join(this.config.repoPath, '.repomemory', 'boundaries.json');
    try {
      const content = readFileSync(configPath, 'utf-8');
      const config = parseDomainConfig(content);
      console.log(`Loaded domain/boundary config with ${config.domains.length} domains.`);
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
      console.log(`Initialized parser for ${lang}`);
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

  async scanFullRepository(): Promise<void> {
    console.log('Starting full repository scan...');
    
    // Get all source files
    const files = await this.getSourceFiles(this.config.repoPath);
    console.log(`Found ${files.length} source files to process.`);

    const results: ParseResult[] = [];
    const embeddings = new Map<string, number[]>();
    
    for (const file of files) {
      try {
        const result = await this.parseFile(file);
        if (!result) continue;
        results.push(result);
        const embs = await this.generateEmbeddings(result);
        embs.forEach((embedding, stableId) => embeddings.set(stableId, embedding));
      } catch (error) {
        console.error(`Error processing ${file}:`, error);
      }
    }
    
    // Fresh full scan: clear previous data for this repo before repopulating
    await this.entityRepo.deleteAll();
    await this.relationshipRepo.deleteAll();
    await this.graphClient.deleteAll(this.config.repoPath);

    await this.storeResolvedResults(results, embeddings);
    
    // Record the latest commit after full scan
    await this.recordCurrentCommit();

    // Ingest commit history so ownership/domain reports have data
    await this.recordCommitHistory(100);
    
    console.log('Full repository scan complete.');
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
      console.error('Failed to record commit:', error);
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
        console.log(`Recorded ${commits.length} commits of history.`);
      }
    } catch (error) {
      console.error('Failed to record commit history:', error);
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
      console.error('Failed to update repo state:', error);
    }
  }

  async scanFromCommit(commitHash?: string): Promise<void> {
    console.log('Starting incremental scan from commit...');
    
    if (!commitHash) {
      const lastCommit = await this.gitOps.getLastCommitHash();
      if (!lastCommit) {
        console.log('No commits found. Running full scan.');
        await this.scanFullRepository();
        return;
      }
      commitHash = lastCommit;
    }
    
    // Get file changes since commit
    const changes = await this.gitOps.getDiffBetweenCommits(commitHash, 'HEAD');
    console.log(`Found ${changes.length} changed files since commit ${commitHash}.`);
    
    await this.processChanges(changes);
    
    await this.recordCurrentCommit();
    console.log('Incremental scan complete.');
  }

  async scanIncremental(): Promise<void> {
    console.log('Starting incremental scan...');

    const lastCommitHash = await this.getLastScannedCommit();
    if (!lastCommitHash) {
      console.log('No previous scan state found. Running full scan.');
      await this.scanFullRepository();
      return;
    }

    const changes = await this.gitOps.getDiffBetweenCommits(lastCommitHash, 'HEAD');
    console.log(`Found ${changes.length} changed files since ${lastCommitHash}.`);

    await this.processChanges(changes);

    await this.recordCurrentCommit();
    console.log('Incremental scan complete.');
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

  async scanWorkingTree(): Promise<void> {
    console.log('Scanning working tree changes...');
    
    const status = await this.gitOps.getStatus();
    const changes: Array<{ filePath: string; status: string }> = [
      ...status.modified.map(file => ({ filePath: file, status: 'modified' })),
      ...status.added.map(file => ({ filePath: file, status: 'added' })),
      ...status.deleted.map(file => ({ filePath: file, status: 'deleted' })),
    ];
    
    console.log(`Found ${changes.length} changed files.`);

    await this.processChanges(changes);
    
    await this.recordCurrentCommit();
    console.log('Working tree scan complete.');
  }

  // Parse, resolve, and persist a batch of changed files. For incremental scans the
  // repo-wide symbol index is loaded from the database so relationships still resolve
  // against definitions in files that were not re-parsed.
  private async processChanges(changes: Array<{ filePath: string; status: string }>): Promise<void> {
    const index = await this.loadSymbolIndex();
    const results: ParseResult[] = [];
    const embeddings = new Map<string, number[]>();

    for (const change of changes) {
      if (change.status === 'deleted') {
        await this.handleFileDeletion(change.filePath);
        continue;
      }
      try {
        const result = await this.parseFile(join(this.config.repoPath, change.filePath));
        if (!result) continue;
        results.push(result);
        index.addFile(result.filePath);
        index.addEntities(result.entities);
        index.addEntity(createFileEntity(result.filePath, this.config.repoPath));
        const embs = await this.generateEmbeddings(result);
        embs.forEach((embedding, stableId) => embeddings.set(stableId, embedding));
      } catch (error) {
        console.error(`Error processing ${change.filePath}:`, error);
      }
    }

    for (const result of results) {
      index.registerRelationships(result.relationships);
    }

    const resolver = new RelationshipResolver(index, this.config.repoPath);
    for (const result of results) {
      const fileEntity = createFileEntity(result.filePath, this.config.repoPath);
      const resolved = resolver.resolveRelationships(result.relationships);
      await this.persistFileResult(result, fileEntity, resolved, embeddings);
    }
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
      console.error(`Failed to read ${filePath}:`, error);
      return null;
    }
    
    // Parse file using cached parser
    const language = getLanguageFromFilePath(filePath);
    const parser = await this.getParser(language);
    
    const result = await parser.parse(relativePath, content, this.config.repoPath);
    
    console.log(`Parsed ${relativePath}: ${result.entities.length} entities, ${result.relationships.length} relationships`);
    return result;
  }

  private async generateEmbeddings(result: ParseResult): Promise<Map<string, number[]>> {
    const embeddings = new Map<string, number[]>();
    for (const entity of result.entities) {
      try {
        const embedding = await generateEntityEmbedding(entity.name, entity.type, entity.filePath);
        embeddings.set(entity.stableId, embedding);
      } catch (error) {
        console.error(`Failed to generate embedding for ${entity.name}:`, error);
      }
    }
    return embeddings;
  }

  // Build the symbol index, resolve all relationships, and persist every file's
  // entities + relationships. Used by full scans.
  private async storeResolvedResults(results: ParseResult[], embeddings: Map<string, number[]>): Promise<void> {
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

    for (const result of results) {
      const fileEntity = fileEntities.get(result.filePath)!;
      const resolved = resolver.resolveRelationships(result.relationships);
      await this.persistFileResult(result, fileEntity, resolved, embeddings);
    }
  }

  private async persistFileResult(
    result: ParseResult,
    fileEntity: Entity,
    resolvedRelationships: Relationship[],
    embeddings: Map<string, number[]>
  ): Promise<void> {
    // Remove stale relationships for this file (e.g. previously unresolved targets)
    await this.relationshipRepo.deleteByFilePath(result.filePath);

    // Populate domain / architecturalRole metadata
    applyDomainMetadata(result.entities, this.domainConfig || undefined);

    const entities = [...result.entities, fileEntity];
    
    // Store entities in both databases
    for (const entity of entities) {
      try {
        await this.entityRepo.upsert(entity);
        await this.graphClient.upsertEntity(entity, this.config.repoPath);
        const embedding = embeddings.get(entity.stableId);
        if (embedding) {
          await this.entityRepo.updateEmbedding(entity.stableId, embedding);
        }
      } catch (error) {
        console.error(`Failed to store entity ${entity.name}:`, error);
      }
    }
    
    // Store relationships in both databases
    for (const relationship of resolvedRelationships) {
      try {
        await this.relationshipRepo.upsert(relationship);
        await this.graphClient.upsertRelationship(relationship);
      } catch (error) {
        console.error(`Failed to store relationship:`, error);
      }
    }
  }

  private async handleFileDeletion(filePath: string): Promise<void> {
    console.log(`Handling deletion of ${filePath}`);
    
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
    const entities: Entity[] = [];
    const limit = 5000;
    let offset = 0;
    while (true) {
      const batch = await this.entityRepo.findAll(limit, offset);
      entities.push(...batch);
      if (batch.length < limit) break;
      offset += limit;
    }

    const relationships: Relationship[] = [];
    for (const type of [
      RelationshipType.CALLS,
      RelationshipType.REFERENCES,
      RelationshipType.IMPORTS,
      RelationshipType.EXTENDS,
      RelationshipType.IMPLEMENTS,
    ]) {
      relationships.push(...(await this.relationshipRepo.findByType(type)));
    }

    return detectDeadCode(entities, relationships);
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

  async close(): Promise<void> {
    await this.graphClient.close();
    await this.pgPool.end();
  }
}
