# Changelog

All notable changes to RepoMemory will be documented in this file.

## [0.5.0] - 2026-08-01

### Added
- **Cross-File Symbol Resolution (Phase 4 M1)**: New `SymbolIndex` + `RelationshipResolver` in `packages/analysis/src/resolver/` that rewrite bare-name relationship targets (`CALLS`, `REFERENCES`, `EXTENDS`, `IMPLEMENTS`, import symbols) to real entity stable IDs, scope-aware: same-file definitions → imported symbols (resolved via import paths) → globally-unique name → ambiguous (prefers exported)
- **FILE Entities**: A `File` entity is now created for every scanned source file, giving imports and exports real graph nodes
- **Relationship Provenance**: Resolved relationships record `resolvedBy`, `resolutionHint`, and `unresolvedTarget` in `metadata`; unresolved references drop to confidence 0.3
- **Import Path Resolution**: `resolveImportPath` helper handles relative paths, package-name → directory index, and unique-basename matches (used by the resolver and reusable by the architecture view)
- **Orchestrator Resolution Pipeline**: Full scans buffer parse results, build a repo-wide symbol index, resolve all relationships, then persist (with repo-scoped cleanup). Incremental scans load the symbol index from the database so only changed files need re-parsing
- **Repo-Scoped Deletes**: `EntityRepository.deleteAll()`, `RelationshipRepository.deleteAll()`, and `GraphClient.deleteAll(repoPath)` for consistent full-scan rebuilds

### Changed
- Import-symbol relationships now store their `importPath` in `metadata` so the resolver can build per-file import maps
- `processFile` split into `parseFile`, `generateEmbeddings`, `persistFileResult`, and `processChanges`/`storeResolvedResults`

### Fixed
- Neo4j `searchEntities` fulltext index (`entitySearch`) was never created, causing runtime errors; it is now created in `createSchema()`
- Neo4j silently dropped every relationship whose source/target wasn't a real stable ID; symbol-level `CALLS`/`REFERENCES`/`EXTENDS`/`IMPLEMENTS` and import-symbol edges now materialize, so dependency/dependent/impact queries return real data

### Added (M2)
- **Dead Code Detection**: `detectDeadCode()` in `packages/analysis/src/deadcode.ts` performs reachability analysis from entrypoint/test roots over resolved edges. Non-exported unreachable entities are flagged dead; exported-but-unreferenced symbols are reported separately
- **Dead Code API**: `GET /api/analysis/dead-code?includeExported=true`
- **Dead Code CLI**: `repo-memory query dead-code --repo <path>`

### Added (M3)
- **Domain Inference**: `inferDomain()` + `inferArchitecturalRole()` in `packages/analysis/src/domain.ts` classify each file into a domain (api / services / core / shared / frontend / scripts / unknown) and architectural role (entrypoint / application / implementation / interface / config)
- **Domain Config**: Optional `.repomemory/boundaries.json` at the repo root defines custom domains, file patterns, `allowedCrossDomain`, and `strict` mode; parsed by `parseDomainConfig()` and applied to entities during scans
- **Ownership Report**: `GET /api/analysis/ownership` computes per-file dominant author from commit history
- **Commit History Ingestion**: Full scans now ingest the last 100 commits (via `getRecentCommitsWithChanges()`) so ownership/commit reports have real data instead of an empty working-tree diff

### Added (M4)
- **Boundary Validation**: `validateBoundaries()` in `packages/analysis/src/boundaries.ts` reports cross-domain edges with allow/deny status against the domain config
- **Boundaries API**: `GET /api/analysis/boundaries` returns domains (with file/entity counts), cross-domain edges, and violations

### Added (M5)
- **Config Entity Fix**: Config files (`package.json`, `tsconfig.json`, `.env`, `Dockerfile`, ...) were skipped by the `shouldParseFile` gate, so `CONFIG` entities never existed. Added exported `isConfigFilePath()` and included config files in both file discovery and parsing
- **HANDLES Relationship**: API endpoints now link to their handlers via `HANDLES`. Named handlers resolve through the symbol index; inline arrow/function handlers are promoted to real entities with `CONTAINS` + `HANDLES` + extracted calls. `HANDLES` added to the resolver's symbol-target types, and targets that are already real stable IDs pass through untouched
- **API Endpoint Detection Fix**: `call_expression` wraps arguments in an `arguments` node, so the old path-string lookup never matched — TypeScript/JavaScript endpoints were never extracted. Now resolved correctly; also added HANDLES to the Python decorator path (`@app.route`/`@app.get`), which was previously unreachable
- **Python Parser Fix**: `PARSER_CONFIGS` was missing `python`, so `resolveGrammarKey` loaded the TypeScript grammar for `.py` files (0 entities). Added the Python entry and fallback
- **Python describe/it Detection**: `describe_*` functions are `TEST_SUITE`, `it_*` are `TEST` (pytest-describe style); fixed ordering so `describe_*` isn't swallowed by `isTestFunction`
- **Python Double-Extraction Fix**: `decorated_definition` no longer re-extracts its wrapped function/class via recursion
- **Model Entity Detection**: New `EntityType.MODEL`; classes matching `Model`/`Dto`/`Schema`/`Record`/`Entity`/`Document` naming, ORM decorators (`@Entity`, `@Schema`, ...), or ORM base classes (`BaseModel`, `db.Model`, ...) are typed as models
- **Test File Detection**: `isTestFileByContent` (describe/it/expect/assert patterns) is now wired into `createEntity`; `isTestFile` also matches Python naming (`test_*.py`, `*_test.py`)

## [0.4.0] - 2026-07-31

### Added
- **Multi-Repository Isolation**: Added `repo_path` scoping to entities, relationships, and commits. Each scanned repo's data is now tagged with its path and filtered out when serving a different repo
- **Repo-Scoped Stable IDs**: Entity stable IDs now include the repo path, preventing collisions between repos with identical file paths/entity names
- **Python Language Support**: New Python parser using Tree-sitter WASM grammar. Extracts functions, classes, methods, constructors (`__init__`), decorators, imports, variables, and docstrings
- **Strategy Pattern Parser Architecture**: Refactored `TreeSitterParser` into a pluggable `LanguageExtractor` interface with per-language implementations (`TypeScriptExtractor`, `JavaScriptExtractor`, `PythonExtractor`)
- **Constructor Detection**: Extracts `constructor` methods from TypeScript/JavaScript classes and `__init__` methods from Python classes as `CONSTRUCTOR` entities
- **Test Entity Detection**: Detects test functions (`test_*`, `it()`, `test()`) and test suites (`describe()`, `context()`) as `TEST` and `TEST_SUITE` entities
- **API Endpoint Detection**: Detects Express/Koa/Fastify routes (`app.get()`, `router.post()`) and Flask/FastAPI routes (`@app.route()`) as `API_ENDPOINT` entities
- **Config File Detection**: Detects configuration files (`package.json`, `tsconfig.json`, `.eslintrc.*`, `pyproject.toml`, etc.) as `CONFIG` entities
- **CALLS Relationship Detection**: Detects function calls and creates `CALLS` relationships between entities
- **REFERENCES Relationship Detection**: Detects symbol references and creates `REFERENCES` relationships
- **CONTAINS Relationship Detection**: Creates `CONTAINS` relationships for structural containment (class contains method, file contains function)
- **Parser Caching**: Orchestrator now caches parser instances per language for better performance

### Changed
- Refactored `TreeSitterParser` to use `LanguageExtractor` strategy pattern
- Updated `EntityRepository` with `deleteByFilePath` method for proper file deletion handling
- Improved `isTestFile()` to detect test files by path patterns (`/test/`, `/tests/`, `/__tests__/`)
- Added `getGrammarKeyFromFilePath()` for proper grammar resolution (fixed TSX grammar bug)
- Added `repoPath` to `ExtractorContext` and `parse()`; repositories and API now filter by served repo path

### Fixed
- Fixed TSX grammar loading bug (grammar key was hardcoded to `'typescript'`)
- Fixed file deletion handling in orchestrator (now properly deletes entities from Neo4j)
- Fixed parser-per-file issue (parsers are now cached per language)
- Fixed "value too long for type character varying(255)" error by increasing relationship ID column sizes to VARCHAR(1000)
- Added ID truncation for long call chains, references, and import paths
- Fixed architecture graph not showing links by adding relative import path resolution
- Fixed `getGroup()` to support external repositories with generic directory patterns
- Fixed frontend scrolling for entity list, commit list, and detail panel

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
