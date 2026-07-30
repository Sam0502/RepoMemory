# Repository Memory Engine

## Project Overview
A repository-scale memory engine that continuously scans source code, extracts structural and semantic knowledge, tracks changes over time, and exposes that knowledge to developers and AI agents.

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
│   ├── analysis/               # Tree-sitter parser + embeddings
│   ├── graph/                  # Neo4j client
│   ├── storage/                # PostgreSQL client
│   └── api/                    # HTTP API + context packs
├── app/                        # Main CLI + orchestration
├── web/                        # Frontend (HTML/CSS/JS)
└── AGENTS.md                   # This file
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
```

### CLI Commands
```bash
# Full repository scan
node app/dist/cli.js scan --repo /path/to/repo --full

# Incremental scan (default)
node app/dist/cli.js scan --repo /path/to/repo --incremental

# Scan working tree changes
node app/dist/cli.js scan --repo /path/to/repo --working-tree

# Query entity
node app/dist/cli.js query entity <stableId>

# Query dependencies
node app/dist/cli.js query dependencies <stableId>

# Query dependents
node app/dist/cli.js query dependents <stableId>

# Search entities
node app/dist/cli.js query search <query>

# Impact analysis
node app/dist/cli.js query impact <stableId>

# Start API server
node app/dist/cli.js serve --repo /path/to/repo --port 3000

# Show stats
node app/dist/cli.js stats --repo /path/to/repo
```

### API Endpoints
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
- `GET /api/context-pack/:stableId` - Generate context pack for AI
- `GET /api/analysis/impact/:stableId` - Impact analysis

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
```

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

# Start server and open frontend
node app/dist/cli.js serve --repo /path/to/test-repo --port 3000
```
