# RepoMemory

A repository-scale memory engine that scans source code, extracts structural and semantic knowledge, tracks changes over time, and exposes that knowledge via API and a web visualization frontend.

See [CHANGELOG.md](CHANGELOG.md) for version history.

**New here? Start with the [System Overview](docs/system-overview.md)** — a plain-English guide to how RepoMemory works, no coding knowledge required.

## What It Does

RepoMemory parses your codebase, builds a knowledge graph of entities (classes, functions, interfaces, etc.) and their relationships, and lets you explore the structure through:

- **Entity search** - find any symbol by name
- **Graph visualization** - D3.js force-directed graph showing entity relationships
- **Impact analysis** - see what's affected when a symbol changes
- **Commit history** - browse recent commits and file changes
- **Context packs** - token-budget context bundles for AI agents
- **Similar entities** - semantic similarity search
- **Cross-file symbol resolution** - bare-name calls/references resolved to real entities via a repo-wide symbol index
- **Dead code detection** - reachability analysis over resolved edges
- **Natural-language QA** - ask questions about the codebase, get evidence-backed answers
- **Ownership & domain inference** - per-file authors, domain/architectural-role classification, boundary validation
- **Change analytics** - churn, risk, and architectural drift scoring from commit history
- **Workspace queries** - cross-repo search, QA, and reporting across all scanned repositories
- **Structured logging & metrics** - pino JSON logs with `PINO_LOG_LEVEL`, per-phase scan telemetry, and a Prometheus `/metrics` endpoint
- **Reconciliation & repair jobs** - `verify`/`repair` dual-store (PostgreSQL vs Neo4j) consistency jobs via CLI and API, persisted to the `jobs` table
- **Streaming analysis** - dead-code, boundaries, risk, and drift run over bounded paged windows (`ANALYSIS_BATCH_SIZE`) instead of loading whole repos, with a `pnpm bench` harness
- **Live file watching** - `repo-memory watch` re-scans changed files on every edit (debounced) via the incremental path, with a live status indicator in the frontend
- **CLI and HTTP API** - query from command line or integrate with tools

## Prerequisites

- Node.js 20+
- pnpm (`npm install -g pnpm`)
- Docker (for Neo4j and PostgreSQL)

## Quick Start

```bash
# 1. Install dependencies
pnpm install

# 2. Start databases
pnpm db:up

# 3. Build all packages
pnpm build

# 4. Scan your repository
node app/dist/cli.js scan --repo /path/to/your/repo --full

# 5. Start the server
node app/dist/cli.js serve --repo /path/to/your/repo --port 3000

# 6. Open http://localhost:3000 in your browser
```

## Project Structure

```
RepoMemory/
├── docker-compose.yml          # Neo4j + PostgreSQL
├── package.json                # Root workspace
├── pnpm-workspace.yaml
├── tsconfig.json
├── packages/
│   ├── shared/                 # Types, interfaces, enums
│   ├── ingestion/              # Git operations, file watcher
│   ├── analysis/               # Tree-sitter parser + embeddings + analysis
│   │   ├── extractors/         # Language-specific extractors
│   │   │   ├── interface.ts    # LanguageExtractor interface
│   │   │   ├── base.ts         # BaseExtractor with shared utilities
│   │   │   ├── typescript.ts   # TypeScript/TSX extractor
│   │   │   ├── javascript.ts   # JavaScript extractor
│   │   │   └── python.ts       # Python extractor
│   │   ├── resolver/           # SymbolIndex + RelationshipResolver
│   │   ├── deadcode.ts         # Dead code detection
│   │   ├── domain.ts           # Domain/role inference + boundary config
│   │   ├── boundaries.ts       # Architecture boundary validation
│   │   ├── change.ts           # ChangeAnalyzer (churn, risk, drift)
│   │   └── embedding/          # Embedding providers
│   ├── graph/                  # Neo4j client
│   ├── storage/                # PostgreSQL client
│   └── api/                    # Hono HTTP API + QA + context packs
├── app/                        # CLI + orchestrator
└── web/                        # Frontend (HTML/CSS/JS)
```

## CLI Commands

```bash
# Full repository scan
node app/dist/cli.js scan --repo /path/to/repo --full

# Incremental scan (default, only changed files)
node app/dist/cli.js scan --repo /path/to/repo --incremental

# Scan working tree changes only
node app/dist/cli.js scan --repo /path/to/repo --working-tree

# Scan from a specific commit
node app/dist/cli.js scan --repo /path/to/repo --commit <hash>

# Start API server with frontend
node app/dist/cli.js serve --repo /path/to/repo --port 3000

# Watch a repo live — re-scans changed files on every edit (debounced)
node app/dist/cli.js watch --repo /path/to/repo --port 3000

# Query entities
node app/dist/cli.js query search "GraphClient"

# Look up an entity by stable ID
node app/dist/cli.js query entity <stableId>

# Get dependencies / dependents / impact
node app/dist/cli.js query dependencies <stableId>
node app/dist/cli.js query dependents <stableId>
node app/dist/cli.js query impact <stableId>

# Dead code report
node app/dist/cli.js query dead-code

# Change analytics
node app/dist/cli.js query churn [limit]
node app/dist/cli.js query risk <stableId>

# Cross-repo queries (search, dead-code accept --all-repos)
node app/dist/cli.js query search "createUser" --all-repos
node app/dist/cli.js query dead-code --all-repos

# List all scanned repositories
node app/dist/cli.js workspace repos

# Run pending database migrations (versioned, idempotent)
node app/dist/cli.js db migrate

# Show repository stats
node app/dist/cli.js stats --repo /path/to/repo

# Reconciliation & repair jobs (PostgreSQL vs Neo4j; also accept --all-repos)
node app/dist/cli.js jobs verify --repo /path/to/repo
node app/dist/cli.js jobs repair --repo /path/to/repo
```

## API Endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | `/health` | Health check |
| GET | `/api/status` | Live watch status (`watching`, `lastScanAt`, `pendingChanges`) |
| GET | `/api/entities` | List all entities |
| GET | `/api/entities/:id` | Get entity by ID |
| GET | `/api/entities/search/:query` | Search entities |
| GET | `/api/entities/type/:type` | Get entities by type |
| GET | `/api/entities/file/:filePath` | Get entities by file |
| GET | `/api/entities/similar/:stableId` | Find similar entities |
| GET | `/api/relationships` | List relationships |
| GET | `/api/graph/traverse/:stableId` | Traverse graph |
| GET | `/api/graph/dependencies/:stableId` | Get dependencies |
| GET | `/api/graph/dependents/:stableId` | Get dependents |
| GET | `/api/graph/transitive/:stableId` | Get transitive dependencies |
| GET | `/api/graph/architecture` | Architecture graph (file-level) |
| GET | `/api/commits` | List recent commits |
| GET | `/api/commits/:hash` | Get commit details + file changes |
| GET | `/api/context-pack/:stableId` | Generate context pack for AI |
| GET | `/api/analysis/impact/:stableId` | Impact analysis |
| GET | `/api/analysis/dead-code` | Dead code report (`?includeExported=true`, `?batchSize=`) |
| GET | `/api/analysis/ownership` | Per-file dominant author report |
| GET | `/api/analysis/boundaries` | Domain boundaries + violations (`?batchSize=`) |
| GET | `/api/analysis/churn` | Top changed files with churn scores (`?limit=`) |
| GET | `/api/analysis/risk` | Repo-level risk with explainable breakdown |
| GET | `/api/analysis/risk/:stableId` | Entity-level change/risk info |
| GET | `/api/analysis/drift` | Architecture drift signals with evidence |
| POST | `/api/qa/ask` | Natural-language QA (`{"question": "..."}`) |
| GET | `/api/jobs` | List reconciliation/repair jobs (`?type=`, `?limit=`) |
| GET | `/api/jobs/:id` | Get a job + its report |
| POST | `/api/jobs/verify` | Verify PostgreSQL vs Neo4j (`{"repoPath": "..."}`) |
| POST | `/api/jobs/repair` | Repair: re-sync Neo4j from PostgreSQL |
| GET | `/api/workspace/repos` | List all scanned repositories + stats |
| GET | `/api/workspace/entities` | Cross-repo entity list |
| GET | `/api/workspace/entities/search/:query` | Cross-repo search |
| GET | `/api/workspace/entities/type/:type` | Cross-repo type listing |
| GET | `/api/workspace/entities/:stableId` | Cross-repo entity lookup by ID |
| POST | `/api/workspace/qa/ask` | Cross-repo QA (answers name their repo) |
| GET | `/metrics` | Prometheus metrics (disable with `METRICS_ENABLED=false`) |

All non-workspace endpoints are scoped to the repository passed to `serve --repo`. Workspace endpoints always read across every scanned repository.

## Docker Services

| Service | Port | URL |
|---------|------|-----|
| Neo4j Browser | 7474 | http://localhost:7474 |
| Neo4j Bolt | 7687 | bolt://localhost:7687 |
| PostgreSQL | 5433 | localhost:5433 |

**Credentials:**
- Neo4j: `neo4j` / `repo-memory-password`
- PostgreSQL: `repo_memory` / `repo-memory-password` (database: `repo_memory`)

## Multi-Repository Support

- Each scanned repo's data is tagged with `repo_path` in the `entities`, `relationships`, and `commits` tables
- Serving a repo (`serve --repo <path>`) filters all non-workspace API responses to that repo only
- Entity stable IDs are namespaced by repo path, so multiple repos with identical file layouts don't collide
- `workspace repos` / `workspace` API endpoints / `query ... --all-repos` read across every scanned repo
- Rescan a repo to re-tag existing data after upgrading from a pre-multi-repo version

## Environment Variables

```bash
# Neo4j
NEO4J_URI=bolt://localhost:7687
NEO4J_USER=neo4j
NEO4J_PASSWORD=repo-memory-password

# PostgreSQL
PG_HOST=localhost
PG_PORT=5433
PG_DATABASE=repo_memory
PG_USER=repo_memory
PG_PASSWORD=repo-memory-password

# Embedding provider (onnx, gemini, or placeholder)
EMBEDDING_PROVIDER=onnx

# Gemini API key (if using gemini provider)
GEMINI_API_KEY=your-key

# Embedding model cache directory
EMBEDDING_CACHE_DIR=./models

# Analysis page size for streaming dead-code/boundaries/risk/drift (default 5000)
ANALYSIS_BATCH_SIZE=5000

# Structured logging level for the pino logger (fatal/error/warn/info/debug/trace)
PINO_LOG_LEVEL=info

# Expose the /metrics Prometheus endpoint (set to 'false' to disable)
METRICS_ENABLED=true
```

## Development

```bash
# Run in development mode (watch for changes)
pnpm dev

# Build all packages
pnpm build

# Type check
pnpm typecheck

# Lint (ESLint)
pnpm lint

# Run tests (Vitest)
pnpm test

# Benchmark streaming analysis on a scanned repo (optionally --full to scan first)
pnpm bench --repo /path/to/repo

# Start databases
pnpm db:up

# Stop databases
pnpm db:down
```

## Architecture

### Ingestion Layer
- Git operations via `simple-git`
- File system watching via `chokidar`
- Incremental scanning from Git diffs (default mode)

### Analysis Layer
- Tree-sitter WASM parser for TypeScript/JavaScript/Python (strategy-pattern extractors)
- Extracts: functions, classes, interfaces, types, enums, methods, properties, constructors, tests, API endpoints, configs, models
- Relationships: imports, exports, extends, implements, calls, references, contains, handles
- **Symbol resolution**: repo-wide `SymbolIndex` + `RelationshipResolver` rewrite bare-name targets to real entity IDs
- **Dead code detection**: reachability analysis over resolved inbound edges
- **Domain inference**: per-file domain + architectural role + optional `.repomemory/boundaries.json`
- **Boundary validation**: cross-domain edge reports against domain rules
- **Change analysis**: `ChangeAnalyzer` computes churn, file risk, entity change info, and drift signals
- **Streaming analysis**: dead-code/boundaries/risk/drift run over bounded paged windows (`ANALYSIS_BATCH_SIZE`) so peak memory stays O(working-set) regardless of repo size
- Multi-provider embeddings (ONNX local, Gemini API, placeholder fallback)

### Storage Layer
- **PostgreSQL** (port 5433): entities, relationships, commits, job state, embeddings (pgvector)
- **Neo4j** (port 7687): graph traversal, relationship queries

### API Layer
- Hono HTTP server
- Serves frontend static files
- CORS enabled for local development
- Context pack generation for AI agents
- Impact analysis with risk scoring
- Natural-language QA service with intent classification and compound-question support
- Workspace (cross-repo) endpoints alongside repo-scoped endpoints

### Frontend
- Entity list with search, type filtering, and repo dropdown (multi-repo)
- D3.js force-directed graph visualization
- Architecture graph (file-level view)
- Commit history panel with file changes
- Entity detail panel with:
  - Core info (type, language, file, lines, exported, confidence)
  - Similar entities (semantic search)
  - Impact analysis (risk score, affected files)
  - Context pack (token-budget context for AI)
- Zoom controls and node dragging
- Loading states and high-contrast graph arrows

## Current Status

**Phase 1 Complete** (v0.1.0):
- Entity extraction (574 entities from self-scan)
- Relationship extraction (imports, exports, extends, implements)
- Dual storage (PostgreSQL + Neo4j)
- HTTP API with graph traversal
- Web visualization frontend
- CLI interface

**Phase 2 Complete** (v0.2.0):
- Tree-sitter WASM parser for accurate AST extraction
- Commit history tracking
- Incremental diff-driven reanalysis
- Semantic embeddings with pgvector
- Context pack generation

**Phase 2.1 Complete** (v0.3.0):
- Frontend redesign with commits panel, impact analysis, context packs
- Tree-sitter WASM initialization fixes
- High-contrast graph visualization

**Phase 3 Complete** (v0.4.0):
- Multi-language support (TypeScript, JavaScript, Python)
- Strategy pattern parser architecture
- Constructor, test, API endpoint, and config entity detection
- CALLS, REFERENCES, and CONTAINS relationship detection
- Parser caching for better performance

**Phase 4 Complete** (v0.5.0–v0.7.0, M1–M9):
- Cross-file symbol resolution (`SymbolIndex` + `RelationshipResolver`)
- Dead code detection (reachability analysis)
- Ownership & domain inference with `.repomemory/boundaries.json` config
- Architecture boundary validation
- Detection improvements (config files, HANDLES, endpoints, models, tests)
- Natural-language QA with compound/multi-hop questions
- Query orchestration (impact, shortest path, changelog, file deps)
- Workspace-wide cross-repo workflows (workspace API, CLI `--all-repos`, frontend repo dropdown)
- Entity-change correlation (churn, risk, drift scoring)

**Next (Phase 5: Hardening & Observability):**
- ✅ Test foundation & quality gates (Vitest, ESLint, CI) — unit tests across 12 files, `pnpm lint`/`pnpm typecheck`/`pnpm test` green
- ✅ Versioned schema migrations (replacing the monolithic `SCHEMA_SQL`; `schema_migrations` ledger + `repo-memory db migrate`)
- ✅ Structured logging (`pino` + `Logger`), scan telemetry (`ScanReport` with per-phase timings), `/metrics` Prometheus endpoint, request logging + `X-Request-Id`
- ✅ Reconciliation & repair jobs over the dual PG/Neo4j store (`repo-memory jobs verify|repair`, `jobs` API)
- ✅ Streaming analysis for repository scale (`ANALYSIS_BATCH_SIZE` paged dead-code/boundaries/risk/drift) + `pnpm bench` benchmark harness
- ✅ Live file watching (`repo-memory watch`, `GET /api/status`, frontend live indicator)
- Multi-language parsers (Go, Rust, Java)
- Multi-language parsers (Go, Rust, Java)

## License

MIT
