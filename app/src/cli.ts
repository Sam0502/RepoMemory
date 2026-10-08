#!/usr/bin/env node

import { parseArgs } from 'node:util';
import { Orchestrator } from './orchestrator.js';
import type { OrchestratorConfig } from './orchestrator.js';
import { createPool, EntityRepository, RelationshipRepository, TraversalService, listWorkspaceRepos, migrate } from '@repo-memory/storage';
import { streamDeadCode, createEmbeddingProvider } from '@repo-memory/analysis';
import type { EmbeddingProvider } from '@repo-memory/analysis';
import { RelationshipType, getLogger } from '@repo-memory/shared';
import type { ScanReport } from '@repo-memory/shared';
import { resolve } from 'path';
import type { EmbeddingConfig } from '@repo-memory/analysis';

const VERSION = '0.1.0';

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

const USAGE = `repo-memory ${VERSION} - Repository Memory Engine - Extract and query structural knowledge from code

Usage: repo-memory <command> [options]

Commands:
  scan        Scan the repository and extract entities and relationships
              [-r, --repo <path>] [-f, --full] [-i, --incremental]
              [-c, --commit <hash>] [-w, --working-tree]
  query       Query the knowledge graph
              [-r, --repo <path>] [-a, --all-repos] <type> [args...]
              (type: entity, dependencies, dependents, search, impact, dead-code, churn, risk)
  workspace   Workspace-wide (cross-repo) queries: repos
  db          Database operations: migrate
  serve       Start the API server [-r, --repo <path>] [-p, --port <port>] [-h, --host <host>]
  watch       Watch the repository and update the graph on every edit (debounced)
              [-r, --repo <path>] [-p, --port <port>] [-h, --host <host>] [-d, --debounce <ms>]
  jobs        Run reconciliation & repair jobs (verify / repair)
              [-r, --repo <path>] [-a, --all-repos] <action>
  stats       Show repository statistics [-r, --repo <path>]
  mcp         Serve repository memory as an MCP server over stdio (for AI agents)
              [-r, --repo <path>]`;

function printUsage(): void {
  console.log(USAGE);
}

function fail(message: string): never {
  logger.error(message);
  console.log(USAGE);
  process.exitCode = 1;
  throw new Error(message);
}

function repoOption(values: Record<string, string | boolean | undefined>): string {
  return typeof values.repo === 'string' && values.repo !== '' ? values.repo : process.cwd();
}

function boolOption(values: Record<string, string | boolean | undefined>, name: string): boolean {
  return values[name] === true;
}

function strOption(values: Record<string, string | boolean | undefined>, name: string): string | undefined {
  const value = values[name];
  return typeof value === 'string' ? value : undefined;
}

const REPO_OPTION = { repo: { type: 'string', short: 'r' } } as const;
const ALL_REPOS_OPTION = { 'all-repos': { type: 'boolean', short: 'a', default: false } } as const;

function parseCommandArgs(args: string[], options: object): Record<string, string | boolean | undefined> {
  const { values } = parseArgs({ args, options: options as never, allowPositionals: true, strict: true });
  return values as Record<string, string | boolean | undefined>;
}

async function runScan(args: string[]): Promise<void> {
  const values = parseCommandArgs(args, {
    ...REPO_OPTION,
    full: { type: 'boolean', short: 'f', default: false },
    incremental: { type: 'boolean', short: 'i', default: false },
    commit: { type: 'string', short: 'c' },
    'working-tree': { type: 'boolean', short: 'w', default: false },
  });
  const options = {
    repo: repoOption(values),
    full: boolOption(values, 'full'),
    incremental: boolOption(values, 'incremental'),
    commit: strOption(values, 'commit'),
    workingTree: boolOption(values, 'working-tree'),
  };
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
}

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

async function runQuery(argv: string[]): Promise<void> {
  const { values, positionals } = parseArgs({
    args: argv,
    options: { ...REPO_OPTION, ...ALL_REPOS_OPTION } as never,
    allowPositionals: true,
    strict: true,
  });
  const options = { repo: repoOption(values as never), allRepos: boolOption(values as never, 'all-repos') };
  const [type, ...args] = positionals;
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
}

async function runWorkspace(argv: string[]): Promise<void> {
  const { positionals } = parseArgs({ args: argv, options: {} as never, allowPositionals: true, strict: true });
  const [type] = positionals;
  if (type !== 'repos') {
    logger.error(`Unknown workspace query type: ${type}`);
    process.exitCode = 1;
    return;
  }

  const pool = await createPool(getDbConfig());
  try {
    const repos = await listWorkspaceRepos(pool);
    if (repos.length === 0) {
      console.log('No scanned repositories found.');
      return;
    }

    for (const row of repos) {
      console.log(
        `${row.repoPath}\t${row.entityCount} entities\t${row.commitCount} commits\t` +
        `last: ${row.lastCommitHash || 'n/a'} (${row.lastScanAt ? new Date(row.lastScanAt).toISOString() : 'n/a'})`
      );
    }
  } catch (error) {
    logger.error({ err: error }, 'Workspace query failed');
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
}

async function runDb(argv: string[]): Promise<void> {
  const { positionals } = parseArgs({ args: argv, options: {} as never, allowPositionals: true, strict: true });
  const [action] = positionals;
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
}

async function runServe(argv: string[]): Promise<void> {
  const values = parseCommandArgs(argv, {
    ...REPO_OPTION,
    port: { type: 'string', short: 'p', default: '3000' },
    host: { type: 'string', short: 'h', default: '127.0.0.1' },
  });
  const port = parseIntArg(strOption(values, 'port'), 'port', 1, 65535);
  if (port === null) return;
  const repoPath = resolve(repoOption(values));
  const host = strOption(values, 'host') ?? '127.0.0.1';

  logger.info({ repoPath }, 'Starting API server');

  // Initialize orchestrator for database connections
  const orchestrator = makeOrchestrator(repoPath);
  await orchestrator.initialize();

  // Start API server
  const { startServer } = await loadApi();
  const pgPool = await createPool(getDbConfig());
  const traversal = new TraversalService(pgPool);

  const server = startServer({
    port,
    host,
    repoPath,
    traversal,
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
}

async function runWatch(argv: string[]): Promise<void> {
  const values = parseCommandArgs(argv, {
    ...REPO_OPTION,
    port: { type: 'string', short: 'p', default: '3000' },
    host: { type: 'string', short: 'h', default: '127.0.0.1' },
    debounce: { type: 'string', short: 'd', default: '500' },
  });
  const port = parseIntArg(strOption(values, 'port'), 'port', 1, 65535);
  if (port === null) return;
  const debounceMs = parseIntArg(strOption(values, 'debounce'), 'debounce (ms)', 1, 3600000);
  if (debounceMs === null) return;
  const repoPath = resolve(repoOption(values));
  const host = strOption(values, 'host') ?? '127.0.0.1';

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
  const { startServer } = await loadApi();
  const pgPool = await createPool(getDbConfig());
  const traversal = new TraversalService(pgPool);

  const server = startServer({
    port,
    host,
    repoPath,
    traversal,
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
}

async function runJobs(argv: string[]): Promise<void> {
  const { values, positionals } = parseArgs({
    args: argv,
    options: { ...REPO_OPTION, ...ALL_REPOS_OPTION } as never,
    allowPositionals: true,
    strict: true,
  });
  const options = { repo: repoOption(values as never), allRepos: boolOption(values as never, 'all-repos') };
  const [action] = positionals;
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
}

async function runStats(argv: string[]): Promise<void> {
  const values = parseCommandArgs(argv, { ...REPO_OPTION });
  const options = { repo: repoOption(values) };
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
}

async function runMcp(argv: string[]): Promise<void> {
  const values = parseCommandArgs(argv, { ...REPO_OPTION });
  const repoPath = resolve(repoOption(values));

  logger.info({ repoPath }, 'Starting MCP server (stdio)');

  const { serveStdio } = await loadMcp();
  const pgPool = await createPool(getDbConfig());
  const traversal = new TraversalService(pgPool);

  const server = await serveStdio({ repoPath, traversal, pgPool, embedder: makeEmbedder() });

  const shutdown = async () => {
    logger.info('Shutting down MCP server');
    await server.close();
    await pgPool.end();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

// `@repo-memory/api` and `@repo-memory/mcp` are optional dependencies —
// imported lazily so scan/query/db/stats/jobs work without them installed.
async function loadApi(): Promise<typeof import('@repo-memory/api')> {
  try {
    return await import('@repo-memory/api');
  } catch {
    logger.error('The API server requires the optional dependency @repo-memory/api — run `pnpm install` to enable serve/watch.');
    process.exitCode = 1;
    throw new Error('Missing optional dependency @repo-memory/api');
  }
}

async function loadMcp(): Promise<typeof import('@repo-memory/mcp')> {
  try {
    return await import('@repo-memory/mcp');
  } catch {
    logger.error('The MCP server requires the optional dependency @repo-memory/mcp — run `pnpm install` to enable mcp.');
    process.exitCode = 1;
    throw new Error('Missing optional dependency @repo-memory/mcp');
  }
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const [command, ...rest] = argv;

  if (!command || command === '--help' || command === '-h' || command === 'help') {
    printUsage();
    return;
  }
  if (command === '--version' || command === '-V') {
    console.log(VERSION);
    return;
  }

  try {
    switch (command) {
      case 'scan':
        await runScan(rest);
        break;
      case 'query':
        await runQuery(rest);
        break;
      case 'workspace':
        await runWorkspace(rest);
        break;
      case 'db':
        await runDb(rest);
        break;
      case 'serve':
        await runServe(rest);
        break;
      case 'watch':
        await runWatch(rest);
        break;
      case 'jobs':
        await runJobs(rest);
        break;
      case 'stats':
        await runStats(rest);
        break;
      case 'mcp':
        await runMcp(rest);
        break;
      default:
        fail(`Unknown command: ${command}`);
    }
  } catch (error) {
    if (error instanceof Error && (error as NodeJS.ErrnoException).code === 'ERR_PARSE_ARGS_UNKNOWN_OPTION') {
      fail(`Unknown option: ${(error as Error).message}`);
    }
    throw error;
  }
}

main().catch((error) => {
  logger.error({ err: error }, 'Command failed');
  process.exitCode = 1;
});
