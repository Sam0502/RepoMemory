#!/usr/bin/env node

import { Command } from 'commander';
import { Orchestrator } from './orchestrator.js';
import type { OrchestratorConfig } from './orchestrator.js';
import { startServer } from '@repo-memory/api';
import { serveStdio } from '@repo-memory/mcp';
import { GraphClient } from '@repo-memory/graph';
import { createPool, EntityRepository, RelationshipRepository, migrate } from '@repo-memory/storage';
import { streamDeadCode, createEmbeddingProvider } from '@repo-memory/analysis';
import type { EmbeddingProvider } from '@repo-memory/analysis';
import { RelationshipType, getLogger } from '@repo-memory/shared';
import type { ScanReport } from '@repo-memory/shared';
import { resolve } from 'path';
import type { EmbeddingConfig } from '@repo-memory/analysis';

const logger = getLogger({ component: 'cli' });

// PostgreSQL config comes from the standard PG_* environment variables, with
// the same defaults used everywhere else in the project.
function getDbConfig(): { host: string; port: number; database: string; user: string; password: string } {
  return {
    host: process.env.PG_HOST || 'localhost',
    port: parseInt(process.env.PG_PORT || '5433', 10),
    database: process.env.PG_DATABASE || 'repo_memory',
    user: process.env.PG_USER || 'repo_memory',
    password: process.env.PG_PASSWORD || 'repo-memory-password',
  };
}

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

function makeOrchestrator(repoPath: string): Orchestrator {
  const db = getDbConfig();
  const config: OrchestratorConfig = {
    repoPath,
    embeddings: getEmbeddingConfig(),
    pgHost: db.host,
    pgPort: db.port,
    pgDatabase: db.database,
    pgUser: db.user,
    pgPassword: db.password,
  };
  return new Orchestrator(config);
}

// Best-effort embedding provider for semantic task-pack seeding. Constructing
// the provider is lazy (the model loads on first embed), so this is safe even
// when the ONNX model isn't downloaded; task packs fall back to keyword.
function makeEmbedder(): EmbeddingProvider | undefined {
  try {
    return createEmbeddingProvider(getEmbeddingConfig());
  } catch (error) {
    logger.warn({ err: error }, 'Embedding provider unavailable; task packs fall back to keyword search');
    return undefined;
  }
}

// Parse a bounded integer CLI argument. On invalid input, logs the problem,
// sets the process exit code, and returns null so callers can bail early
// instead of crashing with an unhandled error.
function parseIntArg(value: string | undefined, name: string, min: number, max: number): number | null {
  if (value === undefined || value === '') {
    logger.error(`Missing required ${name}`);
    process.exitCode = 1;
    return null;
  }
  const n = Number(value);
  if (!Number.isInteger(n) || n < min || n > max) {
    logger.error(`Invalid ${name}: '${value}' (expected an integer in [${min}, ${max}])`);
    process.exitCode = 1;
    return null;
  }
  return n;
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
    const orchestrator = makeOrchestrator(resolve(options.repo));

    try {
      await orchestrator.initialize();

      let report: ScanReport;
      if (options.full) {
        report = await orchestrator.scanFullRepository();
      } else if (options.incremental) {
        report = await orchestrator.scanIncremental();
      } else if (options.commit) {
        report = await orchestrator.scanFromCommit(options.commit);
      } else if (options.workingTree) {
        report = await orchestrator.scanWorkingTree();
      } else {
        report = await orchestrator.scanIncremental();
      }
      printScanReport(report);
    } catch (error) {
      logger.error({ err: error }, 'Scan failed');
      process.exitCode = 1;
    } finally {
      await orchestrator.close();
    }
  });

function printScanReport(report: ScanReport): void {
  console.log(`Scan completed in ${report.totalDurationMs}ms`);
  console.log(
    `  Type: ${report.scanType}${report.commit ? ` | Commit: ${report.commit}` : ''} | Repo: ${report.repoPath}`
  );
  console.log(
    `  Files discovered: ${report.filesDiscovered} | Parsed: ${report.filesParsed} | ` +
    `Entities: ${report.entitiesExtracted} | Relationships: ${report.relationshipsExtracted} | ` +
    `Embeddings: ${report.embeddingsGenerated}`
  );
  console.log(
    `  Stored: ${report.entitiesStored} entities, ${report.relationshipsStored} relationships`
  );
  if (report.phases.length > 0) {
    const nameWidth = Math.max(...report.phases.map(p => p.name.length));
    console.log('  Phases:');
    for (const phase of report.phases) {
      console.log(
        `    ${phase.name.padEnd(nameWidth)}  ${phase.durationMs}ms` +
        (phase.entityCount ? `  entities: ${phase.entityCount}` : '') +
        (phase.relationshipCount ? `  relationships: ${phase.relationshipCount}` : '')
      );
    }
  }
}

program
  .command('query')
  .description('Query the knowledge graph')
  .option('-r, --repo <path>', 'Repository path', process.cwd())
  .option('-a, --all-repos', 'Query across all scanned repositories (search, dead-code)', false)
  .argument('<type>', 'Query type: entity, dependencies, dependents, search, impact, dead-code, churn, risk')
  .argument('[args...]', 'Query arguments')
  .action(async (type, args, options) => {
    const crossRepo = options.allRepos && (type === 'search' || type === 'dead-code');

    if (crossRepo) {
      const pool = await createPool(getDbConfig());
      try {
        const entityRepo = new EntityRepository(pool, '');
        const relationshipRepo = new RelationshipRepository(pool, '');
        if (type === 'search') {
          const results = await entityRepo.search(args.join(' '));
          console.log(JSON.stringify(results, null, 2));
        } else {
          const report = await streamDeadCode(
            { page: (offset, limit) => entityRepo.findAll(limit, offset) },
            {
              page: (offset, limit) =>
                relationshipRepo.findByTypesPaged(
                  [RelationshipType.CALLS, RelationshipType.REFERENCES, RelationshipType.IMPORTS, RelationshipType.EXTENDS, RelationshipType.IMPLEMENTS],
                  limit,
                  offset
                ),
            }
          );
          console.log(JSON.stringify(report, null, 2));
        }
      } catch (error) {
        logger.error({ err: error }, 'Workspace query failed');
        process.exitCode = 1;
      } finally {
        await pool.end();
      }
      return;
    }

    const orchestrator = makeOrchestrator(resolve(options.repo));

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
          const indirectImpact = await orchestrator.getTransitiveDependents(id, 3);
          console.log(JSON.stringify({ directImpact, indirectImpact }, null, 2));
          break;
        }
        case 'dead-code': {
          const report = await orchestrator.getDeadCodeReport();
          console.log(JSON.stringify(report, null, 2));
          break;
        }
        case 'churn': {
          const limit = args[0] !== undefined ? parseIntArg(args[0], 'limit', 1, 100000) : 50;
          if (limit === null) return;
          const churn = await orchestrator.getChurn(limit);
          console.log(JSON.stringify(churn, null, 2));
          break;
        }
        case 'risk': {
          const id = args[0];
          if (!id) {
            logger.error('Usage: repo-memory query risk <stableId>');
            process.exitCode = 1;
            return;
          }
          const risk = await orchestrator.getRisk(id);
          console.log(JSON.stringify(risk, null, 2));
          break;
        }
        default:
          logger.error(`Unknown query type: ${type}`);
          process.exitCode = 1;
      }
    } catch (error) {
      logger.error({ err: error }, 'Query failed');
      process.exitCode = 1;
    } finally {
      await orchestrator.close();
    }
  });

program
  .command('workspace')
  .description('Workspace-wide (cross-repo) queries')
  .argument('<type>', 'Query type: repos')
  .action(async (type) => {
    if (type !== 'repos') {
      logger.error(`Unknown workspace query type: ${type}`);
      process.exitCode = 1;
      return;
    }

    const pool = await createPool(getDbConfig());
    try {
      const result = await pool.query(
        `SELECT e.repo_path AS repo_path,
                COUNT(e.id)::int AS entity_count,
                (SELECT COUNT(*)::int FROM commits c WHERE c.repo_path = e.repo_path) AS commit_count
         FROM entities e
         WHERE e.repo_path <> ''
         GROUP BY e.repo_path
         ORDER BY e.repo_path`
      );
      const state = await pool.query('SELECT repo_path, last_commit_hash, last_scan_at FROM repo_state');
      const stateByPath = new Map(state.rows.map(r => [r.repo_path, r]));

      if (result.rows.length === 0) {
        console.log('No scanned repositories found.');
        return;
      }

      for (const row of result.rows) {
        const st = stateByPath.get(row.repo_path);
        console.log(
          `${row.repo_path}\t${row.entity_count} entities\t${row.commit_count} commits\t` +
          `last: ${st?.last_commit_hash || 'n/a'} (${st?.last_scan_at ? new Date(st.last_scan_at).toISOString() : 'n/a'})`
        );
      }
    } catch (error) {
      logger.error({ err: error }, 'Workspace query failed');
      process.exitCode = 1;
    } finally {
      await pool.end();
    }
  });

program
  .command('db')
  .description('Database operations')
  .argument('<action>', 'Action: migrate')
  .action(async (action) => {
    if (action !== 'migrate') {
      logger.error(`Unknown db action: ${action}. Available: migrate`);
      process.exitCode = 1;
      return;
    }

    const pool = await createPool(getDbConfig());
    try {
      const applied = await migrate(pool);
      if (applied.length === 0) {
        console.log('Database schema is up to date (0 pending migrations).');
      } else {
        for (const migration of applied) {
          console.log(`  Applied migration ${migration.id}-${migration.name}`);
        }
        console.log(`Applied ${applied.length} pending migration(s).`);
      }
    } catch (error) {
      logger.error({ err: error }, 'Migration failed');
      process.exitCode = 1;
    } finally {
      await pool.end();
    }
  });

program
  .command('serve')
  .description('Start the API server')
  .option('-r, --repo <path>', 'Repository path', process.cwd())
  .option('-p, --port <port>', 'Server port', '3000')
  .option('-h, --host <host>', 'Server host', '127.0.0.1')
  .action(async (options) => {
    const port = parseIntArg(options.port, 'port', 1, 65535);
    if (port === null) return;
    const repoPath = resolve(options.repo);
    const host = options.host;

    logger.info({ repoPath }, 'Starting API server');

    // Initialize orchestrator for database connections
    const orchestrator = makeOrchestrator(repoPath);
    await orchestrator.initialize();

    // Start API server
    const graphClient = new GraphClient();
    const pgPool = await createPool(getDbConfig());

    const server = startServer({
      port,
      host,
      repoPath,
      graphClient,
      pgPool,
      logger,
      embedder: makeEmbedder(),
      runJob: (type, repoPath) => orchestrator.runJob(type, repoPath),
    }, resolve(process.cwd(), 'web'));

    // Graceful shutdown: stop accepting requests and release resources.
    const shutdown = async () => {
      logger.info('Shutting down API server');
      server.close();
      await orchestrator.close();
      process.exit(0);
    };
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
  });

program
  .command('watch')
  .description('Watch the repository and update the graph on every edit (debounced)')
  .option('-r, --repo <path>', 'Repository path', process.cwd())
  .option('-p, --port <port>', 'Server port', '3000')
  .option('-h, --host <host>', 'Server host', '127.0.0.1')
  .option('-d, --debounce <ms>', 'Watch debounce in milliseconds', '500')
  .action(async (options) => {
    const port = parseIntArg(options.port, 'port', 1, 65535);
    if (port === null) return;
    const debounceMs = parseIntArg(options.debounce, 'debounce (ms)', 1, 3600000);
    if (debounceMs === null) return;
    const repoPath = resolve(options.repo);
    const host = options.host;

    logger.info({ repoPath, debounceMs }, 'Starting watch mode');

    const orchestrator = makeOrchestrator(repoPath);
    await orchestrator.initialize();

    // Seed the graph on first watch (full scan if nothing is stored yet).
    const hasData = await orchestrator.hasStoredData();
    if (!hasData) {
      logger.info('No prior scan found — running initial full scan');
      printScanReport(await orchestrator.scanFullRepository());
    }

    await orchestrator.startWatching({ debounceMs });

    // Start API server (with live status wired to the watcher)
    const graphClient = new GraphClient();
    const pgPool = await createPool(getDbConfig());

    const server = startServer({
      port,
      host,
      repoPath,
      graphClient,
      pgPool,
      logger,
      embedder: makeEmbedder(),
      runJob: (type, repoPath) => orchestrator.runJob(type, repoPath),
      getStatus: () => orchestrator.getStatus(),
    }, resolve(process.cwd(), 'web'));

    // Keep the process alive; clean up the watcher + server on shutdown.
    const shutdown = async () => {
      logger.info('Shutting down watch mode');
      server.close();
      await orchestrator.stopWatching();
      await orchestrator.close();
      process.exit(0);
    };
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
  });

program
  .command('jobs')
  .description('Run reconciliation & repair jobs (verify / repair)')
  .argument('<action>', 'Job: verify, repair')
  .option('-r, --repo <path>', 'Repository path', process.cwd())
  .option('-a, --all-repos', 'Run the job against every scanned repository', false)
  .action(async (action, options) => {
    if (action !== 'verify' && action !== 'repair') {
      logger.error(`Unknown job: ${action}. Available: verify, repair`);
      process.exitCode = 1;
      return;
    }

    const orchestrator = makeOrchestrator(resolve(options.repo));

    try {
      await orchestrator.initialize();
      const targets = options.allRepos ? await orchestrator.listScannedRepos() : [resolve(options.repo)];
      for (const target of targets) {
        const job = await orchestrator.runJob(action, target);
        console.log(JSON.stringify({
          jobId: job.id,
          type: job.type,
          status: job.status,
          repoPath: job.repositoryPath,
          result: job.result,
          error: job.error,
          createdAt: job.createdAt,
          completedAt: job.completedAt,
        }, null, 2));
      }
    } catch (error) {
      logger.error({ err: error }, 'Job failed');
      process.exitCode = 1;
    } finally {
      await orchestrator.close();
    }
  });

program
  .command('stats')
  .description('Show repository statistics')
  .option('-r, --repo <path>', 'Repository path', process.cwd())
  .action(async (options) => {
    const orchestrator = makeOrchestrator(resolve(options.repo));

    try {
      await orchestrator.initialize();
      
      // Get counts
      const entities = await orchestrator.searchEntities('');
      const totalEntities = entities.length;
      
      console.log('Repository Statistics:');
      console.log(`  Total entities: ${totalEntities}`);
      console.log(`  Repository path: ${options.repo}`);
    } catch (error) {
      logger.error({ err: error }, 'Failed to get stats');
      process.exitCode = 1;
    } finally {
      await orchestrator.close();
    }
  });

program
  .command('mcp')
  .description('Serve repository memory as an MCP server over stdio (for AI agents)')
  .option('-r, --repo <path>', 'Repository path', process.cwd())
  .action(async (options) => {
    const repoPath = resolve(options.repo);

    logger.info({ repoPath }, 'Starting MCP server (stdio)');

    const graphClient = new GraphClient();
    const pgPool = await createPool(getDbConfig());

    const server = await serveStdio({ repoPath, graphClient, pgPool, embedder: makeEmbedder() });

    const shutdown = async () => {
      logger.info('Shutting down MCP server');
      await server.close();
      await pgPool.end();
      await graphClient.close();
      process.exit(0);
    };
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
  });

program.parse();
