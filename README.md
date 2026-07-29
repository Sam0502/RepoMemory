# RepoMemory

A repository-scale memory engine that scans source code, extracts structural and semantic knowledge, tracks changes over time, and exposes that knowledge via API and a web visualization frontend.

See [CHANGELOG.md](CHANGELOG.md) for version history.

## What It Does

RepoMemory parses your codebase, builds a knowledge graph of entities (classes, functions, interfaces, etc.) and their relationships, and lets you explore the structure through:

- **Entity search** - find any symbol by name
- **Graph visualization** - D3.js force-directed graph showing entity relationships
- **Impact analysis** - see what's affected when a symbol changes
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
│   ├── analysis/               # Tree-sitter parser (regex MVP)
│   ├── graph/                  # Neo4j client
│   ├── storage/                # PostgreSQL client
│   └── api/                    # Hono HTTP API server
├── app/                        # CLI + orchestrator
└── web/                        # Frontend (HTML/CSS/JS)
```

## CLI Commands

```bash
# Full repository scan
node app/dist/cli.js scan --repo /path/to/repo --full

# Scan working tree changes only
node app/dist/cli.js scan --repo /path/to/repo --working-tree

# Start API server with frontend
node app/dist/cli.js serve --repo /path/to/repo --port 3000

# Query entities
node app/dist/cli.js query search "GraphClient"

# Show repository stats
node app/dist/cli.js stats --repo /path/to/repo
```

## API Endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | `/health` | Health check |
| GET | `/api/entities` | List all entities |
| GET | `/api/entities/:id` | Get entity by ID |
| GET | `/api/entities/search/:query` | Search entities |
| GET | `/api/entities/type/:type` | Get entities by type |
| GET | `/api/entities/file/:filePath` | Get entities by file |
| GET | `/api/relationships` | List relationships |
| GET | `/api/graph/traverse/:stableId` | Traverse graph |
| GET | `/api/graph/dependencies/:stableId` | Get dependencies |
| GET | `/api/graph/dependents/:stableId` | Get dependents |

## Docker Services

| Service | Port | URL |
|---------|------|-----|
| Neo4j Browser | 7474 | http://localhost:7474 |
| Neo4j Bolt | 7687 | bolt://localhost:7687 |
| PostgreSQL | 5433 | localhost:5433 |

**Credentials:**
- Neo4j: `neo4j` / `repo-memory-password`
- PostgreSQL: `repo_memory` / `repo-memory-password` (database: `repo_memory`)

## Development

```bash
# Run in development mode (watch for changes)
pnpm dev

# Build all packages
pnpm build

# Type check
pnpm typecheck

# Start databases
pnpm db:up

# Stop databases
pnpm db:down
```

## Architecture

### Ingestion Layer
- Git operations via `simple-git`
- File system watching via `chokidar`
- Incremental scanning from Git diffs

### Analysis Layer
- Regex-based parser for TypeScript/JavaScript (MVP)
- Extracts: functions, classes, interfaces, types, enums, variables
- Relationships: imports, exports, extends, implements

### Storage Layer
- **PostgreSQL** (port 5433): entities, relationships, commits, job state
- **Neo4j** (port 7687): graph traversal, relationship queries

### API Layer
- Hono HTTP server
- Serves frontend static files
- CORS enabled for local development

### Frontend
- Entity list with search/filter
- D3.js force-directed graph visualization
- Entity detail panel
- Zoom controls and node dragging

## Current Status

**Phase 1 Complete:**
- ✅ Entity extraction (155 entities from self-scan)
- ✅ Relationship extraction (imports, exports, extends, implements)
- ✅ Dual storage (PostgreSQL + Neo4j)
- ✅ HTTP API with graph traversal
- ✅ Web visualization frontend
- ✅ CLI interface

**Next (Phase 2):**
- Tree-sitter WASM parser for accurate AST extraction
- Cross-file symbol resolution
- Incremental diff-driven reanalysis
- Semantic embeddings with pgvector

## License

MIT
