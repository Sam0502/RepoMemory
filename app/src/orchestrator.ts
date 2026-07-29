import { Pool } from 'pg';
import { GraphClient } from '@repo-memory/graph';
import { EntityRepository, RelationshipRepository, migrate, createPool } from '@repo-memory/storage';
import { GitOperations } from '@repo-memory/ingestion';
import { TreeSitterParser, getLanguageFromFilePath, shouldParseFile } from '@repo-memory/analysis';
import { Entity, Relationship, FileChange } from '@repo-memory/shared';
import { existsSync, readFileSync } from 'fs';
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
}

export class Orchestrator {
  private graphClient: GraphClient;
  private pgPool!: Pool;
  private entityRepo!: EntityRepository;
  private relationshipRepo!: RelationshipRepository;
  private gitOps: GitOperations;
  private config: OrchestratorConfig;

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
    this.entityRepo = new EntityRepository(this.pgPool);
    this.relationshipRepo = new RelationshipRepository(this.pgPool);
    console.log('Initializing Repository Memory Engine...');
    
    // Verify database connections
    await this.graphClient.verifyConnectivity();
    
    // Run migrations
    await migrate(this.pgPool);
    
    // Create Neo4j schema
    await this.graphClient.createSchema();
    
    console.log('Initialization complete.');
  }

  async scanFullRepository(): Promise<void> {
    console.log('Starting full repository scan...');
    
    const fs = await import('fs/promises');
    const path = await import('path');
    
    // Get all source files
    const files = await this.getSourceFiles(this.config.repoPath);
    console.log(`Found ${files.length} source files to process.`);
    
    for (const file of files) {
      try {
        await this.processFile(file);
      } catch (error) {
        console.error(`Error processing ${file}:`, error);
      }
    }
    
    console.log('Full repository scan complete.');
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
    
    for (const change of changes) {
      try {
        if (change.status !== 'deleted') {
          await this.processFile(join(this.config.repoPath, change.filePath));
        } else {
          await this.handleFileDeletion(change.filePath);
        }
      } catch (error) {
        console.error(`Error processing ${change.filePath}:`, error);
      }
    }
    
    console.log('Incremental scan complete.');
  }

  async scanWorkingTree(): Promise<void> {
    console.log('Scanning working tree changes...');
    
    const status = await this.gitOps.getStatus();
    const filesToProcess = [...status.modified, ...status.added];
    
    console.log(`Found ${filesToProcess.length} modified/added files.`);
    
    for (const file of filesToProcess) {
      try {
        await this.processFile(join(this.config.repoPath, file));
      } catch (error) {
        console.error(`Error processing ${file}:`, error);
      }
    }
    
    for (const file of status.deleted) {
      try {
        await this.handleFileDeletion(file);
      } catch (error) {
        console.error(`Error handling deletion of ${file}:`, error);
      }
    }
    
    console.log('Working tree scan complete.');
  }

  private async processFile(filePath: string): Promise<void> {
    if (!shouldParseFile(filePath)) {
      return;
    }
    
    const relativePath = filePath.replace(this.config.repoPath, '').replace(/^[/\\]/, '');
    
    // Read file content
    let content: string;
    try {
      content = readFileSync(filePath, 'utf-8');
    } catch (error) {
      console.error(`Failed to read ${filePath}:`, error);
      return;
    }
    
    // Parse file
    const language = getLanguageFromFilePath(filePath);
    const parser = new TreeSitterParser(language);
    await parser.initialize();
    
    const result = await parser.parse(relativePath, content);
    
    console.log(`Parsed ${relativePath}: ${result.entities.length} entities, ${result.relationships.length} relationships`);
    
    // Store entities in both databases
    for (const entity of result.entities) {
      try {
        await this.entityRepo.upsert(entity);
        await this.graphClient.upsertEntity(entity);
      } catch (error) {
        console.error(`Failed to store entity ${entity.name}:`, error);
      }
    }
    
    // Store relationships in both databases
    for (const relationship of result.relationships) {
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
    await this.entityRepo.findByFilePath(filePath);
    await this.graphClient.deleteEntitiesByFilePath(filePath);
    
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
      } else if (entry.isFile() && shouldParseFile(entry.name)) {
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

  async close(): Promise<void> {
    await this.graphClient.close();
    await this.pgPool.end();
  }
}
