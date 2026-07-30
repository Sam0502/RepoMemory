# Changelog

All notable changes to RepoMemory will be documented in this file.

## [0.3.0] - 2026-07-30

### Added
- **Commit History Panel**: New "Commits" tab in the frontend showing recent commits with hash, message, author, and relative time. Click a commit to expand file changes inline with A/M/D status badges
- **Context Pack Display**: Entity detail panel shows token-budget context packs for AI agents
- **Impact Analysis**: Risk score visualization (green/yellow/red bar) with direct/indirect dependent counts and affected files list
- **Similar Entities**: Semantic similarity section in entity detail panel, click to navigate
- **Type Filter**: Dropdown filter in entity sidebar to filter by Class/Interface/Function/Method/Enum/Variable/Property
- **Loading States**: Spinner overlay on graph area during data fetches
- **Custom Scrollbar**: Styled scrollbars in sidebars
- **High-Contrast Graph Arrows**: Links and arrows now use bright gray (#c9d1d9) with 80% opacity for better visibility

### Fixed
- **Tree-sitter WASM Initialization**: Fixed `Cannot read properties of undefined (reading 'init')` error by properly loading WASM grammar bytes via `readFile` + `Uint8Array` instead of file path strings
- **WASM Grammar Path Resolution**: Changed to use `import.meta.resolve` for ESM-compatible module resolution
- **Web-tree-sitter Version**: Pinned to `0.22.6` to match WASM grammar ABI from `tree-sitter-wasms@0.1.13` (0.26.x was incompatible)
- **CSS `.hidden` Class**: Added generic `.hidden` rule so loading overlays and panels hide correctly

### Changed
- Frontend redesigned with header nav tabs (Architecture/Commits), improved panel layout, and better typography
- Entity detail panel restructured into sections: Info, Identity, Similar Entities, Impact Analysis, Context Pack
- Graph arrows and links now high-contrast for better readability

## [0.2.0] - 2026-07-29

### Added
- **Tree-sitter WASM Parser**: Replaced regex-based parsing with actual `web-tree-sitter` AST parsing for TypeScript and JavaScript. Extracts functions, classes, interfaces, type aliases, enums, methods, properties, and lexical declarations with accurate position tracking
- **Commit History Tracking**: New `CommitRepository` for storing/querying commits and file changes. API endpoints for listing recent commits and viewing commit details
- **Incremental Diff-Driven Reanalysis**: `scanIncremental()` method that computes Git diff from last scanned commit, re-parses only changed files. New `repo_state` table for tracking scan state. Default scan mode is now incremental (falls back to full scan)
- **Multi-Provider Embeddings**: Pluggable embedding system with `OnnxEmbeddingProvider` (local ONNX via transformers.js), `GeminiEmbeddingProvider` (Google Gemini API), and `PlaceholderEmbeddingProvider` (fallback). Configured via `EMBEDDING_PROVIDER` env var with automatic fallback chain
- **Embedding Dimension Normalization**: All embeddings normalized to 768 dimensions for cross-provider compatibility. MiniLM's 384-dim vectors padded and re-normalized
- **Context Pack Generation**: `ContextPackBuilder` that assembles entity context bundles including dependencies, dependents, recent changes, and similar entities. Token budget support with relevance-based trimming

### Changed
- Parser now uses actual Tree-sitter AST instead of regex patterns
- Default `scan` command behavior changed from full scan to incremental scan
- Scan operations now record commits and update repo state

### Fixed
- Parser now properly extracts methods and properties inside class bodies
- Better TypeScript AST node type mapping for accurate entity classification

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
