#!/usr/bin/env node

import { Command } from 'commander';
import { Orchestrator } from './orchestrator.js';
import { startServer } from '@repo-memory/api';
import { GraphClient } from '@repo-memory/graph';
import { createPool } from '@repo-memory/storage';
import { resolve } from 'path';
import type { EmbeddingConfig } from '@repo-memory/analysis';

function getEmbeddingConfig(): EmbeddingConfig {
  const provider = process.env.EMBEDDING_PROVIDER || 'onnx';
  const modelCacheDir = process.env.EMBEDDING_CACHE_DIR || resolve(process.cwd(), 'models');

  return {
    provider: provider as EmbeddingConfig['provider'],
    onnx: {
      modelId: process.env.EMBEDDING_MODEL || 'Xenova/all-MiniLM-L6-v2',
      cacheDir: modelCacheDir,
    },
    gemini: process.env.GEMINI_API_KEY
      ? { apiKey: process.env.GEMINI_API_KEY, model: process.env.EMBEDDING_MODEL }
      : undefined,
  };
}

const program = new Command();

program
  .name('repo-memory')
  .description('Repository Memory Engine - Extract and query structural knowledge from code')
  .version('0.1.0');

program
  .command('scan')
  .description('Scan the repository and extract entities and relationships')
  .option('-r, --repo <path>', 'Repository path', process.cwd())
  .option('-f, --full', 'Perform a full repository scan (rescan everything)', false)
  .option('-i, --incremental', 'Perform an incremental scan from last state', false)
  .option('-c, --commit <hash>', 'Scan from a specific commit')
  .option('-w, --working-tree', 'Scan only working tree changes', false)
  .action(async (options) => {
    const orchestrator = new Orchestrator({
      repoPath: resolve(options.repo),
      embeddings: getEmbeddingConfig(),
    });

    try {
      await orchestrator.initialize();

      if (options.full) {
        await orchestrator.scanFullRepository();
      } else if (options.incremental) {
        await orchestrator.scanIncremental();
      } else if (options.commit) {
        await orchestrator.scanFromCommit(options.commit);
      } else if (options.workingTree) {
        await orchestrator.scanWorkingTree();
      } else {
        await orchestrator.scanIncremental();
      }
    } catch (error) {
      console.error('Scan failed:', error);
      process.exit(1);
    } finally {
      await orchestrator.close();
    }
  });

program
  .command('query')
  .description('Query the knowledge graph')
  .option('-r, --repo <path>', 'Repository path', process.cwd())
  .argument('<type>', 'Query type: entity, dependencies, dependents, search, impact, dead-code')
  .argument('[args...]', 'Query arguments')
  .action(async (type, args, options) => {
    const orchestrator = new Orchestrator({
      repoPath: resolve(options.repo),
      embeddings: getEmbeddingConfig(),
    });

    try {
      await orchestrator.initialize();

      switch (type) {
        case 'entity': {
          const id = args[0];
          const entity = await orchestrator.getEntityByStableId(id);
          if (entity) {
            console.log(JSON.stringify(entity, null, 2));
          } else {
            console.log('Entity not found');
          }
          break;
        }
        case 'dependencies': {
          const id = args[0];
          const deps = await orchestrator.getDependencies(id);
          console.log(JSON.stringify(deps, null, 2));
          break;
        }
        case 'dependents': {
          const id = args[0];
          const deps = await orchestrator.getDependents(id);
          console.log(JSON.stringify(deps, null, 2));
          break;
        }
        case 'search': {
          const query = args.join(' ');
          const results = await orchestrator.searchEntities(query);
          console.log(JSON.stringify(results, null, 2));
          break;
        }
        case 'impact': {
          const id = args[0];
          const directImpact = await orchestrator.getDependents(id);
          const indirectImpact = await orchestrator.getTransitiveDependencies(id, 3);
          console.log(JSON.stringify({ directImpact, indirectImpact }, null, 2));
          break;
        }
        case 'dead-code': {
          const report = await orchestrator.getDeadCodeReport();
          console.log(JSON.stringify(report, null, 2));
          break;
        }
        default:
          console.error(`Unknown query type: ${type}`);
          process.exit(1);
      }
    } catch (error) {
      console.error('Query failed:', error);
      process.exit(1);
    } finally {
      await orchestrator.close();
    }
  });

program
  .command('serve')
  .description('Start the API server')
  .option('-r, --repo <path>', 'Repository path', process.cwd())
  .option('-p, --port <port>', 'Server port', '3000')
  .option('-h, --host <host>', 'Server host', 'localhost')
  .action(async (options) => {
    const repoPath = resolve(options.repo);
    const port = parseInt(options.port);
    const host = options.host;

    console.log(`Starting API server for repository: ${repoPath}`);

    // Initialize orchestrator for database connections
    const orchestrator = new Orchestrator({ repoPath, embeddings: getEmbeddingConfig() });
    await orchestrator.initialize();

    // Start API server
    const graphClient = new GraphClient();
    const pgPool = await createPool({
      host: 'localhost',
      port: 5433,
      database: 'repo_memory',
      user: 'repo_memory',
      password: 'repo-memory-password',
    });

    startServer({
      port,
      host,
      repoPath,
      graphClient,
      pgPool,
    }, resolve(process.cwd(), 'web'));
  });

program
  .command('stats')
  .description('Show repository statistics')
  .option('-r, --repo <path>', 'Repository path', process.cwd())
  .action(async (options) => {
    const orchestrator = new Orchestrator({
      repoPath: resolve(options.repo),
      embeddings: getEmbeddingConfig(),
    });

    try {
      await orchestrator.initialize();
      
      // Get counts
      const entities = await orchestrator.searchEntities('');
      const totalEntities = entities.length;
      
      console.log('Repository Statistics:');
      console.log(`  Total entities: ${totalEntities}`);
      console.log(`  Repository path: ${options.repo}`);
    } catch (error) {
      console.error('Failed to get stats:', error);
      process.exit(1);
    } finally {
      await orchestrator.close();
    }
  });

program.parse();
