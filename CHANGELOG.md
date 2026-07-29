# Changelog

All notable changes to RepoMemory will be documented in this file.

## [0.1.0] - 2026-07-29

### Added
- **Project Structure**: pnpm workspace monorepo with packages for shared, ingestion, analysis, graph, storage, and api
- **Docker Services**: Neo4j (graph database) and PostgreSQL with pgvector (metadata storage)
- **Entity Extraction**: Regex-based parser for TypeScript/JavaScript (functions, classes, interfaces, types, enums, variables)
- **Relationship Extraction**: imports, exports, extends, implements relationships
- **Dual Storage**: Entities and relationships stored in both PostgreSQL and Neo4j
- **HTTP API**: Hono-based REST API with endpoints for entities, relationships, and graph traversal
- **CLI Interface**: Commands for scanning repositories, querying entities, and starting the API server
- **Web Frontend**: 
  - Entity list with search and type filtering
  - D3.js force-directed graph visualization
  - Entity detail panel with metadata
  - Architecture view showing file-level structure
  - Zoom controls and node dragging
  - Tooltips on hover
- **Architecture Graph**: High-level view of repository structure showing files as nodes grouped by package
- **Static File Serving**: Frontend served from the same API server

### Fixed
- Orchestrator now stores all relationships (not just those with matching entities)
- Graph traversal queries PostgreSQL for relationships instead of Neo4j
- Relationship schema uses VARCHAR instead of UUID for flexible ID storage
- CORS headers added for frontend development
- Parser extracts meaningful entities (exported symbols) instead of all variables

### Changed
- Parser improved to extract exported functions, classes, interfaces, types, and enums
- Graph traversal shows entities in the same file as dependencies
- Architecture graph resolves package imports to actual file paths

## [Unreleased]

### Planned
- Tree-sitter WASM parser for accurate AST extraction
- Cross-file symbol resolution
- Incremental diff-driven reanalysis
- Semantic embeddings with pgvector
- Commit history tracking
- Impact analysis improvements
