# Repository Memory Engine

## Project Overview
A repository-scale memory engine that continuously scans source code, extracts structural and semantic knowledge, tracks changes over time, and exposes that knowledge to developers and AI agents.

## Feature Highlights
- **Entity extraction** across TypeScript / JavaScript / Python via Tree-sitter WASM
- **Graph relationships**: imports, exports, extends, implements, calls, references, contains, handles
- **Cross-file symbol resolution**: `SymbolIndex` + `RelationshipResolver` rewrite bare-name targets to real entity stable IDs
- **Dead code detection**: reachability analysis over resolved inbound edges
- **Ownership & domain inference**: per-file dominant author, domain/architectural-role classification, `.repomemory/boundaries.json` config
- **Boundary validation**: cross-domain edge reports against domain rules
- **Change analytics**: churn, risk, and architectural drift scoring from commit history
- **Natural-language QA**: intent-classified answers with evidence, compound/multi-hop questions
- **Workspace-wide (cross-repo) queries**: search, QA, and reporting across all scanned repositories
- **CLI and HTTP API** for both developers and AI agents

## Tech Stack
- **Runtime:** Node.js 20+
- **Package Manager:** pnpm
- **Language:** TypeScript
- **Build Tool:** tsup
- **Dev Server:** tsx watch
- **Graph Database:** Neo4j (Docker)
- **Metadata Database:** PostgreSQL + pgvector (Docker)
- **Parser:** Tree-sitter WASM (v0.22.6)
- **API Framework:** Hono
- **Embeddings:** ONNX (all-MiniLM-L6-v2) + Gemini API + placeholder fallback

## Project Structure
```
RepoMemory/
├── docker-compose.yml          # Neo4j + PostgreSQL
├── package.json                # Root workspace
├── pnpm-workspace.yaml
├── tsconfig.json
├── packages/
│   ├── shared/                 # Types, interfaces
│   ├── ingestion/              # Git ops, file watcher
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
├── app/                        # CLI + orchestration
└── web/                        # Frontend (HTML/CSS/JS)
```

## Development Commands

### Setup
```bash
# Install dependencies
pnpm install

# Start databases
pnpm db:up

# Run migrations
pnpm --filter @repo-memory/storage db:migrate
```

### Development
```bash
# Run in development mode
pnpm dev

# Build all packages
pnpm build

# Type check
pnpm typecheck

# Lint (ESLint flat config)
pnpm lint

# Run tests (Vitest)
pnpm test
pnpm test:watch

# Benchmark streaming analysis on a scanned repo (--full to scan first, --batch N for page size)
pnpm bench --repo /path/to/repo
```

## CLI Commands

### Scanning
```bash
# Full repository scan (first onboarding, rebuild)
node app/dist/cli.js scan --repo /path/to/repo --full

# Incremental scan (default, only changed files since last scan)
node app/dist/cli.js scan --repo /path/to/repo --incremental

# Scan working tree changes only
node app/dist/cli.js scan --repo /path/to/repo --working-tree

# Scan from a specific commit
node app/dist/cli.js scan --repo /path/to/repo --commit <hash>
```

### Queries
```bash
# Query entity
node app/dist/cli.js query entity <stableId>

# Query dependencies
node app/dist/cli.js query dependencies <stableId>

# Query dependents
node app/dist/cli.js query dependents <stableId>

# Search entities
node app/dist/cli.js query search <query>

# Impact analysis (direct + indirect dependents)
node app/dist/cli.js query impact <stableId>

# Dead code report
node app/dist/cli.js query dead-code

# Change analytics (churn / risk)
node app/dist/cli.js query churn [limit]
node app/dist/cli.js query risk <stableId>

# Cross-repo queries (search, dead-code accept --all-repos)
node app/dist/cli.js query search "createUser" --all-repos
node app/dist/cli.js query dead-code --all-repos
```

### Workspace / Serve / Stats
```bash
# List all scanned repositories with entity/commit counts
node app/dist/cli.js workspace repos

# Start API server
node app/dist/cli.js serve --repo /path/to/repo --port 3000

# Show stats
node app/dist/cli.js stats --repo /path/to/repo
```

### Reconciliation & repair jobs
```bash
# Compare PostgreSQL vs Neo4j for a repo (per-type counts, missing/orphan
# entities + relationships, duplicate graph nodes, embedding nulls)
node app/dist/cli.js jobs verify --repo /path/to/repo

# Re-sync Neo4j from PostgreSQL: upsert missing entities/relationships, delete
# orphan graph nodes/edges, re-embed entities with null embeddings
node app/dist/cli.js jobs repair --repo /path/to/repo

# Run a job against every scanned repository
node app/dist/cli.js jobs verify --all-repos
node app/dist/cli.js jobs repair --all-repos
```
```

### Database migrations
```bash
# Run pending schema migrations (versioned, idempotent; no-op when up to date)
node app/dist/cli.js db migrate
pnpm --filter @repo-memory/storage db:migrate
```

## API Endpoints
- `GET /health` - Health check
- `GET /api/entities` - List entities
- `GET /api/entities/:id` - Get entity by ID
- `GET /api/entities/search/:query` - Search entities
- `GET /api/entities/type/:type` - Get entities by type
- `GET /api/entities/file/:filePath` - Get entities by file
- `GET /api/entities/similar/:stableId` - Find similar entities
- `GET /api/relationships` - List relationships
- `GET /api/graph/traverse/:stableId` - Traverse graph
- `GET /api/graph/dependencies/:stableId` - Get dependencies
- `GET /api/graph/dependents/:stableId` - Get dependents
- `GET /api/graph/transitive/:stableId` - Get transitive dependencies
- `GET /api/graph/architecture` - Architecture graph (file-level)
- `GET /api/commits` - List recent commits
- `GET /api/commits/:hash` - Get commit details + file changes
- `GET /api/context-pack/:stableId` - Generate context pack for AI (`?tokenBudget=`)
- `GET /api/analysis/impact/:stableId` - Impact analysis (transitive dependents + risk)
- `GET /api/analysis/dead-code` - Dead code report (`?includeExported=true`, `?batchSize=`)
- `GET /api/analysis/ownership` - Per-file dominant author report
- `GET /api/analysis/boundaries` - Domain boundaries + violations (`?batchSize=`)
- `GET /api/analysis/churn` - Top changed files with churn scores (`?limit=`)
- `GET /api/analysis/risk` - Repo-level risk with explainable breakdown
- `GET /api/analysis/risk/:stableId` - Entity-level change/risk info
- `GET /api/analysis/drift` - Architecture drift signals with evidence
- `POST /api/qa/ask` - Natural-language QA (`{"question": "..."}`)
- `GET /api/jobs` - List reconciliation/repair jobs (`?type=`, `?limit=`)
- `GET /api/jobs/:id` - Get a job + its report
- `POST /api/jobs/verify` - Run a verify job (`{"repoPath": "..."}`; 501 without a wired job runner)
- `POST /api/jobs/repair` - Run a repair job (re-syncs Neo4j from PostgreSQL)
- `GET /api/workspace/repos` - List all scanned repositories + stats
- `GET /api/workspace/entities` - Cross-repo entity list (optional `repoPath` filter)
- `GET /api/workspace/entities/search/:query` - Cross-repo search
- `GET /api/workspace/entities/type/:type` - Cross-repo type listing
- `GET /api/workspace/entities/:stableId` - Cross-repo entity lookup by ID
- `POST /api/workspace/qa/ask` - Cross-repo QA (answers name their repo)
- `GET /metrics` - Prometheus metrics (`METRICS_ENABLED=false` disables)

All non-workspace endpoints are scoped to the repository passed to `serve --repo`. Workspace endpoints always read across every scanned repository.

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

# Embeddings
EMBEDDING_PROVIDER=onnx        # onnx, gemini, or placeholder
GEMINI_API_KEY=your-key         # if using gemini
EMBEDDING_CACHE_DIR=./models    # model cache directory

# Analysis
ANALYSIS_BATCH_SIZE=5000        # page size for streaming dead-code/boundaries/risk/drift

# Logging & metrics
PINO_LOG_LEVEL=info             # fatal/error/warn/info/debug/trace (structured JSON to stderr)
METRICS_ENABLED=true            # set to 'false' to disable the /metrics endpoint
```

## Multi-Repository Support
- Each scanned repo's data is tagged with `repo_path` in the `entities`, `relationships`, and `commits` tables
- Serving a repo (`serve --repo <path>`) filters all non-workspace API responses to that repo only
- Entity stable IDs are namespaced by repo path, so multiple repos with identical file layouts don't collide
- `workspace repos` / `workspace` API endpoints / `query ... --all-repos` read across every scanned repo
- Rescan a repo to re-tag existing data after upgrading from a pre-multi-repo version

## Docker Services
- **Neo4j:** http://localhost:7474 (browser), bolt://localhost:7687
- **PostgreSQL:** localhost:5433

## Known Issues
- `web-tree-sitter` pinned to v0.22.6 for WASM grammar compatibility with `tree-sitter-wasms@0.1.13`
- ONNX embedding model must be downloaded separately: `pnpm --filter @repo-memory/analysis download-model`

## Testing
Tests will be added in Phase 3. For now, verify functionality with:
```bash
# Scan a test repository
node app/dist/cli.js scan --repo /path/to/test-repo --full

# Query results
node app/dist/cli.js query search "function"

# Change analytics
node app/dist/cli.js query churn 10
node app/dist/cli.js query risk <stableId>

# Start server and open frontend
node app/dist/cli.js serve --repo /path/to/test-repo --port 3000
```
