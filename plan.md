# Repository Memory Engine Plan


## Objective
Build a repository-scale memory engine that continuously scans a source code repository, extracts structural and semantic knowledge, tracks change over time, and exposes that knowledge to developers and AI agents as a persistent, queryable source of truth.

Visualization is a consumer of the system, not the product itself.

## Initial Decisions
These are the concrete starting assumptions for Phase 1.

- Target stack: Neo4j for graph relationships, PostgreSQL for metadata and history, and pgvector for embeddings.
- First parser target: TypeScript / JavaScript.
- Application shape: a single modular application first, with clear boundaries for later service extraction.
- Graph database strategy: commit to Neo4j early rather than using an in-process graph library as the primary store.
- Embeddings: local embeddings first, using a lightweight model such as all-MiniLM-L6-v2 via ONNX.
- Ingestion watch mechanism: file-system watching for local changes plus Git diff reconciliation for commits and history.
- Context packs: designed for both AI agents and developer tooling, including local assistants such as opencode.
- Deployment target: a local CLI-driven service with an HTTP API, with UI added later if needed.
- Phase 1 scope: a working MVP that parses one language, stores graph data, and answers basic structural and impact queries.

## Project Setup Decisions
- Project structure: use a workspace-style monorepo layout with a top-level app plus internal packages for ingestion, analysis, graph, search, and shared utilities.
- Package manager: pnpm.
- Build tool: tsup for production builds, with TypeScript for type-checking.
- Dev server: tsx watch for fast local iteration.
- Dependency injection: keep dependencies explicit through constructor injection instead of a DI container.
- Tree-sitter binding: use web-tree-sitter (WASM) for the primary implementation, with native bindings reserved for later optimization if needed.
- Phase 1 API cut line: support both basic entity / relationship lookups and direct graph traversal such as import chains and caller / callee exploration.

## Core Principles
- Incremental first: process Git diffs and targeted file changes before considering any full rescan.
- AST-backed extraction: use Tree-sitter or language-specific parsers for reliable entity and relationship discovery.
- Graph-native model: store structure, dependency, ownership, and evolution as traversable graph data.
- Semantic enrichment: every entity should carry intent, role, domain, and usage metadata.
- AI-ready retrieval: support search, traversal, impact analysis, and context-pack generation with minimal token waste.
- History-aware: preserve architectural and dependency evolution across commits.

## Scope
The engine should capture:
- Repositories, modules, folders, files
- Classes, interfaces, structs, enums, functions, methods, APIs, tests
- Database models, schema objects, config files, workflows
- Imports, calls, inheritance, composition, ownership, test coverage, API usage, data flow, domain boundaries
- Commit history, file diffs, relationship changes, and architectural drift

## Proposed Architecture

### 1. Ingestion Layer
Responsibilities:
- Watch repositories for commits, branches, and file changes
- Resolve changed files from Git diffs
- Schedule incremental parsing jobs
- Fall back to full repository scan only when necessary
- Reconcile file-system events with commit history so local edits and committed changes stay in sync

Inputs:
- Git commits and diffs
- File system snapshots
- Language configuration and parser registry

### 2. Analysis Layer
Responsibilities:
- Parse source files with AST-based analyzers
- Extract entities and symbols
- Resolve relationships between entities
- Detect tests, models, APIs, config, and ownership hints
- Produce normalized graph events

Recommended approach:
- Tree-sitter as the primary multi-language parser, using the WASM binding for easier setup and broader portability
- Language-specific parsers or plugins where deeper semantic resolution is needed
- Lightweight heuristic enrichment for documentation, naming, and domain hints
- Start with a TypeScript / JavaScript parser pipeline for the first implementation slice

### 3. Knowledge Graph Layer
Responsibilities:
- Persist nodes and edges for entities and relationships
- Version nodes and edges over time
- Support traversal and graph projections for multiple views

Recommended storage:
- Neo4j or equivalent graph database for relationships
- PostgreSQL or SQLite for metadata, history, jobs, and indexing state
- Vector database for embeddings and semantic retrieval

### 4. Semantic Layer
Responsibilities:
- Generate embeddings for files, entities, and contextual chunks
- Index natural-language descriptions, intent, and architectural notes
- Support hybrid retrieval: semantic search plus graph traversal

### 5. Context Pack Layer
Responsibilities:
- Build agent-ready context bundles from graph + metadata + embeddings
- Select relevant files, symbols, tests, dependencies, and recent changes
- Minimize noise by ranking by relevance and architectural distance

### 6. Query and API Layer
Responsibilities:
- Expose graph traversal, search, and analysis APIs
- Serve both developer UI and AI agent clients
- Provide explainable answers with traceable evidence
- Support both CLI-oriented workflows and HTTP access for agents and other tools
- Phase 1 should ship a small but real traversal API, not just flat lookups

## Entity Model
Capture at minimum:
- Repository
- Package / module
- Folder
- File
- Class / interface / struct / enum
- Function / method / constructor / property
- API endpoint / route / handler
- Test / test suite / fixture
- Database model / table / migration / schema object
- Configuration file / config block
- Domain capability / bounded context / service
- Commit / change set / diff hunk

Each entity should store:
- Stable identifier
- Name and canonical path
- Type and language
- Purpose and responsibility
- Domain / bounded context
- Architectural role
- Public surface area
- Consumers and dependencies
- Confidence score for extracted metadata
- First seen / last seen timestamps
- Version or commit lineage

## Relationship Model
Capture relationships such as:
- imports / exports / requires
- calls / invokes / references
- extends / implements / overrides
- contains / owns / composes
- reads from / writes to
- tests / covers / validates
- exposes / handles / routes
- depends on / depends indirectly on
- belongs to domain / crosses boundary / violates boundary
- changed by / introduced in / removed in

Relationships should be directional, typed, and time-aware.

## Semantic Metadata
For every relevant entity, infer and store:
- Purpose
- Responsibility
- Domain alignment
- Architectural significance
- Stability / churn level
- Dependency risk
- Public or internal status
- Related concepts and synonyms
- Test coverage strength
- Recent activity and change risk

## Incremental Update Strategy
The default update path should be:
1. Detect changed commit or file set.
2. Compute Git diff.
3. Reparse only touched files and any impacted neighbors.
4. Update entity graph, metadata, embeddings, and history records.
5. Recompute affected relationship paths and derived views.
6. Mark stale or removed entities as deprecated or deleted.

Only run a full repository scan when:
- The repo is first onboarded
- Parser configuration changes materially
- A recovery operation is needed after corruption or missing history
- Incremental reconciliation detects inconsistencies

## Graph Views
Generate these views as derived projections:
- Repository architecture graph
- Module dependency graph
- File dependency graph
- Class relationship graph
- Function call graph
- Domain and ownership graph
- Change history graph

Each view should support:
- Progressive zoom from top-level to detailed nodes
- Filtering by language, domain, ownership, and churn
- Queryable path explanation for AI and humans

## Search and Analysis Capabilities
The engine should support:
- Semantic search across files, symbols, and metadata
- Graph traversal from a node to neighbors and downstream impact
- Impact analysis for proposed changes
- Dead code detection using usage and coverage signals
- Dependency analysis and cycle detection
- Architecture validation against domain rules
- Change risk scoring using historical churn and fan-out

## Agent-Ready Context Packs
A context pack should include:
- Relevant files and excerpts
- Related functions and classes
- Architectural notes and boundaries
- Dependency chains and transitive callers/callees
- Test coverage and test file links
- Recent changes and commit references
- Domain knowledge and ownership signals
- Open questions or uncertainty markers

Generation strategy:
- Start from the query intent
- Expand through graph neighbors
- Rank by architectural proximity and recent relevance
- Deduplicate aggressively
- Keep provenance for every selected item

## APIs
Expose APIs that let agents ask:
- Where should this feature be implemented?
- What files are affected by this change?
- Which service owns this capability?
- What tests cover this functionality?
- What architectural constraints exist here?
- What changed recently in this area?
- What is the transitive dependency chain?

Recommended API surfaces:
- Search API
- Graph traversal API
- Impact analysis API
- Context pack API
- History API
- Validation API

## Data Storage
Use a three-store split:
- Graph database: Neo4j for nodes, edges, traversals, and projections
- Vector database: pgvector-backed embeddings for semantic retrieval and similarity search
- Relational database: PostgreSQL for metadata, job state, commit history, parser output, lineage, and caches

## System Phases

### Phase 1: Foundation ✅ COMPLETE
- Define canonical entity and relationship schemas ✅
- Build repository ingestion and commit diff detection ✅
- Implement one parser pipeline for TypeScript / JavaScript ✅
- Persist graph nodes, edges, and metadata ✅
- Expose a minimal query API for structural lookup, direct traversal, and basic impact analysis ✅
- Add web visualization frontend ✅ (bonus)

**Status:** Phase 1 completed 2026-07-29. Phase 2 completed 2026-07-30.

**Phase 2 additions:**
- Tree-sitter WASM parser (pinned to v0.22.6 for ABI compatibility)
- Commit history tracking with file change details
- Incremental diff-driven reanalysis as default scan mode
- Multi-provider embeddings (ONNX local + Gemini API + fallback)
- Context pack generation with token budget support
- HTTP API with commits, similarity search, and context pack endpoints
- Frontend redesign with commits panel, impact analysis, context packs, type filter
- High-contrast graph visualization with loading states

### Phase 2: Incremental Intelligence ✅ COMPLETE

**Start Date:** 2026-07-29
**Completed:** 2026-07-30 (v0.2.0 + v0.3.0)

#### 2.1 Commit History Tracking ✅
- Created `CommitRepository` (`packages/storage/src/commit-repository.ts`) for storing/querying commits
- Populate commits table during scan operations
- Added API endpoints: `GET /api/commits`, `GET /api/commits/:hash`

#### 2.2 Incremental Diff-Driven Reanalysis ✅
- Added `repo_state` table to track last scanned commit per repository
- Implemented `scanIncremental()` in orchestrator
- Added `--incremental` flag to CLI (default behavior)

#### 2.3 Tree-sitter WASM Parser ✅
- Replaced regex-based parser with actual `web-tree-sitter` WASM parsing
- Loads TypeScript/JavaScript grammars from `tree-sitter-wasms@0.1.13`
- **Pinned `web-tree-sitter` to v0.22.6** for WASM ABI compatibility (0.26.x incompatible)
- WASM grammar bytes loaded via `readFile` + `Uint8Array` (not file path strings)
- Extracts proper AST entities: functions, classes, interfaces, types, enums, methods, properties
- Accurate line/column tracking from AST node positions

#### 2.4 Multi-Provider Embeddings ✅
- Pluggable provider system: `OnnxEmbeddingProvider`, `GeminiEmbeddingProvider`, `PlaceholderEmbeddingProvider`
- ONNX via `@xenova/transformers` (supports all-MiniLM-L6-v2)
- Gemini API via native fetch (free tier support)
- Fallback chain: primary provider → fallback provider → placeholder
- 768-dim normalized vectors for cross-provider compatibility
- Added similarity search endpoint: `GET /api/entities/similar/:stableId`

#### 2.5 Context Pack Generation ✅
- Created `ContextPackBuilder` in `packages/api/src/context-pack.ts`
- Generated agent-ready context bundles with relevance ranking
- Added endpoint: `GET /api/context-pack/:stableId?tokenBudget=4000`

#### 2.6 Frontend Redesign ✅ (v0.3.0)
- **Commit History Panel**: New "Commits" tab with inline file change expansion
- **Impact Analysis**: Risk score bar (green/yellow/red) + dependent counts + affected files
- **Similar Entities**: Semantic similarity section in entity detail
- **Context Pack Display**: Token-budget context shown in monospace block
- **Type Filter**: Dropdown to filter entities by type
- **Loading States**: Spinner overlay during graph fetches
- **High-Contrast Graph**: Bright arrows (#c9d1d9) with 80% opacity
- **Generic `.hidden` class**: Fixed CSS for overlay/panel visibility

**Execution Order:** 2.1 → 2.2 → 2.3 → 2.4 → 2.5

### Phase 3: Multi-Language Coverage + Detection Improvements ✅ COMPLETE

**Start Date:** 2026-07-31
**Completed:** 2026-07-31 (v0.4.0)

#### 3.1 Refactor Parser to Strategy Pattern ✅
- Created `LanguageExtractor` interface in `packages/analysis/src/extractors/interface.ts`
- Created `BaseExtractor` with shared utilities in `packages/analysis/src/extractors/base.ts`
- Moved TypeScript extraction to `TypeScriptExtractor` in `packages/analysis/src/extractors/typescript.ts`
- Created `JavaScriptExtractor` in `packages/analysis/src/extractors/javascript.ts`
- Updated `TreeSitterParser` to use strategy pattern
- Added parser caching per language in orchestrator

#### 3.2 Python Language Support ✅
- Added `Language.PYTHON` to shared types
- Added Python grammar to `tree-sitter-init.ts`
- Created `PythonExtractor` in `packages/analysis/src/extractors/python.ts`
- Extracts: functions, classes, methods, constructors (`__init__`), decorators, imports, variables, docstrings
- Updated `getLanguageFromFilePath()` and `shouldParseFile()` for Python

#### 3.3 Entity Detection Improvements ✅
- **Constructor Detection**: Extracts `constructor` methods (TypeScript/JavaScript) and `__init__` (Python) as `CONSTRUCTOR` entities
- **Test Entity Detection**: Detects test functions (`test_*`, `it()`, `test()`) and test suites (`describe()`, `context()`) as `TEST`/`TEST_SUITE` entities
- **API Endpoint Detection**: Detects Express/Koa/Fastify routes and Flask/FastAPI routes as `API_ENDPOINT` entities
- **Config File Detection**: Detects configuration files as `CONFIG` entities

#### 3.4 Relationship Detection Improvements ✅
- **CALLS Relationship**: Detects function calls and creates `CALLS` relationships
- **REFERENCES Relationship**: Detects symbol references and creates `REFERENCES` relationships
- **CONTAINS Relationship**: Creates `CONTAINS` relationships for structural containment

**Execution Order:** 3.1 → 3.2 → 3.3 → 3.4

#### 3.5 Bugfixes ✅
- Fixed "value too long for type character varying(255)" by increasing relationship ID columns to VARCHAR(1000)
- Added ID truncation for long call chains, references, and import paths
- Fixed architecture graph not showing links by adding relative import path resolution (`resolveRelativeImport()`)
- Fixed `getGroup()` to support external repositories with generic directory patterns (tests, source, lib, cmd, etc.)
- Fixed frontend scrolling for entity list, commit list, and detail panel (added `min-height: 0` and flex layout)

#### 3.6 Multi-Repository Isolation ✅
- Added `repo_path` column to `entities`, `relationships`, and `commits` tables with safe migrations
- Replaced relationships unique constraint with repo-scoped variant `(repo_path, source_id, target_id, type, file_path)`
- Namespaced stable ID generation with repo path to prevent cross-repo collisions in PostgreSQL and Neo4j
- Scoped `EntityRepository`, `RelationshipRepository`, and `CommitRepository` by repo path
- Scoped Neo4j `GraphClient` entity storage/querying by repo path
- Filtered all API endpoints and architecture graph queries by the served repo path
- Passed `repoPath` through CLI `serve` command and orchestrator

### Phase 4: Multi-Language Coverage
- Add parser adapters for more languages (Go, Rust, Java, etc.) — *deferred, not part of this Phase 4 pass*
- Improve API, test, config, and model detection
- Strengthen ownership and domain inference
- Add architecture boundary validation

### Phase 4 (Non-Multi-Language) ✅ M1-M9 COMPLETE

**Started:** 2026-08-01
**Completed:** 2026-08-01 (M1-M9)

#### 4.1 Cross-File Symbol Resolution ✅
- Added `SymbolIndex` + `RelationshipResolver` in `packages/analysis/src/resolver/`
- Rewrites bare-name relationship targets (CALLS/REFERENCES/EXTENDS/IMPLEMENTS/import symbols) to real entity stable IDs via scope-aware lookup (same-file → import → global-unique → ambiguous)
- Added `File` entities per source file so imports/exports participate in the graph
- Import-symbol relationships now store `importPath` in metadata for per-file import-map building
- Orchestrator full scans buffer + resolve + persist (with repo-scoped cleanup); incremental scans load the symbol index from the database
- Fixed Neo4j `entitySearch` fulltext index (missing → runtime error) and `deleteAll(repoPath)`
- Verified: CALLS/REFERENCES/import symbols resolve across files; Neo4j dependents + CLI impact analysis return real data

#### 4.2 Dead Code Detection ✅
- Reachability from root set over resolved inbound edges; non-exported unreachable entities flagged
- `detectDeadCode()` in `packages/analysis/src/deadcode.ts`, `GET /api/analysis/dead-code`, CLI `query dead-code`

#### 4.3 Ownership & Domain Inference ✅
- Per-file dominant author from commits; heuristic domain/architecturalRole inference; optional `.repomemory/boundaries.json`
- `inferDomain()`/`inferArchitecturalRole()`/`parseDomainConfig()` in `packages/analysis/src/domain.ts`
- Full scans ingest last 100 commits (`getRecentCommitsWithChanges()`) so ownership reports have real data
- `GET /api/analysis/ownership` returns per-file dominant author

#### 4.4 Architecture Boundary Validation ✅
- Boundary rules over resolved edges + inferred domains; violation reporting
- `validateBoundaries()` in `packages/analysis/src/boundaries.ts`; `GET /api/analysis/boundaries`

#### 4.5 Detection Improvements ✅
- Config-entity bug fixed: exported `isConfigFilePath()`; config files now flow through discovery + parsing (previously gated out by `shouldParseFile`)
- HANDLES relationship: endpoints link to handlers (named via symbol index, inline promoted to entities); added to resolver symbol-target types; already-resolved targets pass through
- API endpoint detection fixed: `arguments` node wrapping meant TS/JS endpoints were never extracted; Python `@app.route`/`@app.get` decorators now create endpoints + HANDLES (was unreachable)
- Python parser fixed: `PARSER_CONFIGS` missing `python` caused TS grammar load → 0 entities
- Python describe/it: `describe_*` → TEST_SUITE, `it_*` → TEST; fixed double-extraction of decorated functions
- Model entity detection: `EntityType.MODEL` via naming, ORM decorators, and ORM base classes
- `isTestFileByContent` wired into `createEntity`; `isTestFile` matches Python `test_*`/`*_test` naming

#### 4.6 AI & Developer Workflows ✅
- **Git commit metadata fixes**: `git log --numstat --summary` (with parse of numstat + summary lines) replaces the old `--name-status` for commit + file-change ingestion; `git show` no longer used. File changes now carry real add/delete counts (added/modified/deleted/renamed statuses)
- **Commit history on scans**: full/incremental/working-tree scans ingest last 100 commits and annotate entity `firstSeenCommit`/`lastSeenCommit` (matched via normalized paths)
- **Commit upsert fix**: `commit_repository` upsert now `ON CONFLICT (commit_hash, file_path) DO UPDATE` so stale `0` counts from previous `--name-status` rows don't persist
- **Natural-language QA**: `QaService` (`packages/api/src/qa.ts`) classifies intents (dependencies / dependents / location / ownership / dead-code / tests / info) and answers with evidence; `POST /api/qa/ask` endpoint
- **Frontend contract fixes**: commit list uses `date`, file-change rows use `status` (numstat statuses), context-pack panel renders the structured `ContextPack` shape
- **Graph traversal fixes**: `HANDLES` added to dependency/dependent/transitive queries so routes show as callers of their handlers; self-referencing `REFERENCES` eliminated (function/variable names compared by position, not object identity, since `childForFieldName` returns a distinct node object)
- **QA ownership fix**: questions naming a file (e.g. `who owns src/unused.ts`) resolve the exact file via path tokens before falling back to the generic entity search
- Verified end-to-end: `who calls createUser` → "used by: POST /users/:id"; `who calls list_users` → "GET /users"; `who owns src\unused.ts` → "owned by test (1 commits)"; commits/file-changes show real `+11 -0` etc.

#### 4.7 Query Orchestration (compound / multi-hop questions) ✅
- **Compound questions**: `QaService.ask` splits questions on `and` / `then` / `;` / `.` and answers each fragment, inheriting the entity from the previous fragment when a fragment doesn't name one (`where is X defined and who calls it`)
- **New intents**: `impact` (direct + transitive dependents, affected files, risk score), `path` (shortest path between two entities), `changelog` (recent commits touching a file), `file-deps` (imports + referenced symbols for a File entity)
- **GraphClient additions**: `findTransitiveDependents`, `findShortestPath` (shortest-path traversal, direction-aware via relationship source identity)
- **Entity resolution improvements**: HTTP-verb extraction (`POST /users/:id`), file-path token extraction, second-entity search from the end of the question (skipping generic tokens + the first entity's name tokens), file-different-from-first scan for path questions
- **File-level graph connectivity**: the orchestrator now re-anchors `EXPORTS`/module `IMPORTS` sourceIds from the raw file-path string to the File entity's stableId, and synthesizes `File -[CONTAINS]-> symbol` edges so file nodes connect to their symbols in Neo4j
- **Two-phase persistence**: full scans store all entity nodes before any relationship, so graph `upsertRelationship` (which `MATCH`es both endpoints) no longer silently drops edges to not-yet-stored targets
- **Path traversal includes CONTAINS/EXPORTS** so file↔symbol connectivity is reachable; dependency/dependent/impact queries keep the real dependency edge set (no containment noise)
- **Impact API fix**: `/api/analysis/impact/:stableId` now uses `findTransitiveDependents` (was `findTransitiveDependencies` — wrong direction)
- Verified end-to-end: `how does src\routes.ts relate to src\api\users.ts` → `IMPORTS getUser <-- IMPORTS src\api\users.ts`; `how is POST /users/:id related to createUser` → `HANDLES`; compound dead-code + ownership answers

#### 4.8 Workspace-Wide Workflows (cross-repo queries) ✅ COMPLETE
The engine already tags every entity / relationship / commit with `repo_path` and namespaces stable IDs per repo, but the API server is bound to a single `--repo`. M8 adds a workspace lens that reads across all scanned repositories without changing the per-repo serving model.

- **Status:** Completed 2026-08-01. Verified against two scanned repos: `workspace/repos` lists both, cross-repo search returns results with distinct `repo_path`, and workspace QA answers are repo-annotated (ambiguity aggregates per repo).
- **Unfiltered repositories**: `EntityRepository`, `RelationshipRepository`, and `CommitRepository` already treat an empty `repoPath` as "no filter" (`repoPath ? [..., repoPath] : [...]`); GraphClient must be confirmed/patched to do the same so workspace queries work against one unfiltered repo set
- **Workspace API** (new endpoints in `packages/api/src/server.ts`, always available alongside the scoped ones):
  - `GET /api/workspace/repos` — distinct repos with per-repo entity count, commit count, last-scan commit / timestamp (`SELECT repo_path, COUNT(*) ... GROUP BY repo_path`)
  - `GET /api/workspace/entities/search/:query` — cross-repo search; each result carries its `repo_path`
  - `GET /api/workspace/entities/type/:type` — cross-repo type listing grouped by repo
  - `POST /api/workspace/qa/ask` — cross-repo QA where every answer/entity names its repo, and ambiguous matches aggregate per repo
- **QaService workspace mode** (`packages/api/src/qa.ts`): construct QaService with `repoPath: ''`; `resolveEntity` matches across repos and returns repo-qualified candidates; dependents/impact answers annotate results with `repo_path`
- **CLI**: `repo-memory workspace repos` and a `--all-repos` flag on `query search` / `query dead-code` (app/src/cli.ts) for cross-repo reporting
- **Frontend (optional)**: repo dropdown in the entity/QA panels; no frontend work required for the API to be useful
- **Verification**: scan a second test repo, then confirm `workspace/repos` lists both, cross-repo search returns results with distinct `repo_path`, and QA answers are repo-annotated; `pnpm -r run typecheck`
- **Implemented**: `repoPath` mapped through entity/commit repos + graph client; workspace endpoints (`/api/workspace/repos|entities/search|entities/type|qa/ask`); `QaService` workspace mode with per-repo ambiguity aggregation; CLI `workspace repos` + `--all-repos` on `query search`/`query dead-code`; frontend repo dropdown (`#repoFilter`) with `repo-tag` styling and `currentRepo` filtering in `web/app.js`

#### 4.9 Entity-Change Correlation (drift, churn, risk scoring) ✅ COMPLETE
We ingest commit history + file changes + per-entity `firstSeenCommit`/`lastSeenCommit`, but nothing yet turns that history into change metrics. M9 adds a change-analysis layer over the existing data.

- **Status:** Completed 2026-08-01. Verified: `query churn 10` → real per-file scores (e.g. `session-ses_0592.md` +1665/-1665 → 4995), `query risk <stableId>` → entity change info + owning-file churn, `GET /api/analysis/drift` → boundary/unstable-surface signals with evidence.

- **ChangeAnalyzer** (`packages/analysis/src/change.ts`):
  - `computeFileChurn(repoPath, limit, days?)` — per file: commit count, total additions/deletions, churn score (`adds + k*deletes`), recent-window churn (last N days)
  - `computeFileRisk(repoPath)` — score 0-100 combining churn, inbound fan-out (dependents), boundary violations, dead-code flags, and staleness (age since last change); returns a breakdown so the score is explainable
  - `computeEntityChange(stableId)` — change count, first/last seen, staleness, churn of the owning file
  - `detectDrift(repoPath)` — signals of architectural drift: high-churn files whose tests didn't change in the same window, boundary violations introduced by recent changes, and unstable public surfaces (exported symbols churned across many commits)
- **Storage additions** (`packages/storage/src/commit-repository.ts`): aggregate queries over `file_changes`/`commits` — `SELECT file_path, COUNT(*) AS commits, SUM(additions) AS added, SUM(deletions) AS deleted FROM file_changes GROUP BY file_path` with optional `repo_path` + date-window filters
- **API** (`packages/api/src/server.ts`):
  - `GET /api/analysis/churn?limit=` — top churned files with scores
  - `GET /api/analysis/risk/:stableId` and `GET /api/analysis/risk` — entity-level and repo-level risk with breakdown
  - `GET /api/analysis/drift` — drift signals with evidence (which commits introduced them)
- **QA intents** (`packages/api/src/qa.ts`): `churn` ("which files change the most?"), `drift` ("is the architecture drifting?"); extend `changelog` to accept a symbol and list commits touching its owning file
- **CLI**: `repo-memory query churn --repo <path>`, `repo-memory query risk <stableId>`
- **Verification**: run churn/risk/drift against the test repo, sanity-check scores against known commits; `pnpm -r run typecheck`
- **Implemented**: `ChangeAnalyzer` + `ChangeDataProvider` in `packages/analysis/src/change.ts` (provider interface keeps the analysis package free of pg/storage deps); storage aggregate queries `getFileChurn`/`getLastCommitDate`; API `GET /api/analysis/churn|risk|risk/:stableId|drift`; QA `churn`/`drift` intents in `answerRepoLevel`; CLI `query churn [limit]` / `query risk <stableId>` via orchestrator `getChurn`/`getFileRisk`/`getRisk`/`getDrift`

### Phase 4: AI and Developer Workflows
- Ship traversal, impact analysis, and dead code detection
- Add question-answer APIs for agents
- Build progressive exploration and architecture views
- Add confidence scoring and provenance

### Phase 5: Hardening & Observability

**Start Date:** 2026-08-02
**Completed:** TBD (5.1–5.5 complete)

Phase 5 hardens the engine for real-world use: a real test suite (currently none exists), structured observability, versioned schema migrations, dual-store reconciliation with repair jobs, streaming analysis for repository scale, live file watching, and the deferred Go/Rust/Java parsers. It turns the monolithic scan into a monitored, repairable, quality-gated pipeline.

**Current gaps this phase closes** (verified by codebase audit 2026-08-02):
- No test files, no test framework, no CI, no ESLint (the `lint` script is `tsc --noEmit`) ✅ (5.1)
- No structured logging/metrics — ~75 raw `console.log/error` call sites ✅ (5.3)
- `migrate()` is one monolithic idempotent SQL blob, not versioned; `storage` `db:migrate` script points at a nonexistent `src/migrate.ts` ✅ (5.2)
- `jobs` table exists in the schema but is never written to ✅ (5.4)
- `FileWatcher` (chokidar) exists but is never wired into the orchestrator
- Dead-code / risk / drift / boundaries load entire repo datasets into memory via paged loops ✅ (5.5)
- No reconciliation or repair path for the dual-store (PostgreSQL + Neo4j) split ✅ (5.4)
- Only TypeScript / JavaScript / Python parsers ship

#### 5.1 Test Foundation & Quality Gates ✅
- **Test framework**: add Vitest to the workspace (`pnpm -r` script `test`); root `pnpm test` runs all packages.
- **Unit tests**:
  - `packages/shared`: stable-ID generation and namespacing
  - `packages/analysis/extractors`: TypeScript/JavaScript/Python fixture files → expected entities/relationships (functions, classes, interfaces, enums, methods, constructors, endpoints, tests, configs, models, CALLS/REFERENCES/CONTAINS/HANDLES/IMPORTS/EXPORTS)
  - `packages/analysis/resolver`: `SymbolIndex.lookup` scope chain (same-file → import → global-unique → ambiguous), `resolveImportPath` (relative / package→index / unique-basename), `RelationshipResolver` metadata (`resolvedBy`, `resolutionHint`, `unresolvedTarget`)
  - `packages/analysis`: `detectDeadCode`, `inferDomain`/`inferArchitecturalRole`/`applyDomainMetadata`/`parseDomainConfig`, `validateBoundaries` (strict vs imports-only, wildcards), `ChangeAnalyzer` churn/risk/drift scoring against synthetic rows
  - `packages/api`: `QaService` intent classification + compound-question splitting; `ContextPackBuilder` token budgeting
- **Integration tests** (require DBs via `db:up`): entity/relationship/commit repositories against PostgreSQL (repo-scoped + unfiltered modes), `GraphClient` upsert/traversal against Neo4j
- **CI**: GitHub Actions workflow (`.github/workflows/ci.yml`): install → typecheck → build → test → self-scan smoke test against a small fixture repo
- **Lint**: ESLint flat config + Prettier; wire into `pnpm lint` and CI
- **Verify**: `pnpm -r run typecheck`, `pnpm -r run lint`, `pnpm test` green on a clean checkout

#### 5.2 Versioned Schema Migrations ✅ COMPLETE
- **Status:** Completed 2026-08-02. Verified end-to-end against Postgres: fresh `db:migrate` on a clean database produces the current schema (`entities` with `repo_path` + `embedding`, `relationships` with repo-scoped unique constraint and VARCHAR(1000) `source_id`/`target_id`, all indexes), re-running is a no-op, and `schema_migrations` records applied version + timestamp. Existing installs back-fill cleanly (the pre-migration DB was migrated in place with zero data loss).
- **`MigrationRunner`** (`packages/storage/src/migrations/runner.ts`): creates the `schema_migrations` table (`id INTEGER PRIMARY KEY`, `name`, `applied_at`), reads the applied ledger, then runs pending migrations in ascending id order — each in its own transaction (`BEGIN`/`COMMIT`/`ROLLBACK` on failure) and inserts the ledger row in the same transaction so a failed migration leaves no partial record. Returns `MigrationResult[]` for the CLI to report.
- **Numbered migrations** (`packages/storage/src/migrations/`):
  - `001-init.ts` — extensions (`uuid-ossp`, `vector`), base tables (`entities`, `relationships`, `commits`, `file_changes`, `jobs`, `repo_state`) and base indexes (pre-repo-path, pre-embedding shape)
  - `002-repo-path-scoping.ts` — `repo_path` columns, drop the old `relationships` unique constraint and add the repo-scoped `(repo_path, source_id, target_id, type, file_path)` one, repo-path indexes
  - `003-embeddings.ts` — `entities.embedding vector(768)` + hnsw cosine index
  - `004-id-lengths.ts` — widen `relationships.source_id`/`target_id` to VARCHAR(1000)
  - Every migration is idempotent (`IF NOT EXISTS` / guarded `DO` blocks), so back-filling an already-migrated database is safe.
- **Entrypoints**: `packages/storage/src/migrate.ts` is the real script target for `pnpm --filter @repo-memory/storage db:migrate` (now `tsx src/migrate.ts` instead of the broken `ts-node` loader; reads `PG_HOST`/`PG_PORT`/`PG_DATABASE`/`PG_USER`/`PG_PASSWORD`). `schema.ts` `migrate()` delegates to the runner (kept as the orchestrator's on-init migration call). New CLI surface `repo-memory db migrate` (env-aware DB config).
- **Tests**: `packages/storage/test/migrations.test.ts` (registry ordering/contiguity + runner skip/apply logic against a mock pool) and `migrations-integration.test.ts` (fresh-database apply, schema-shape assertions, no-op re-run against a dedicated `repo_memory_test` database, skipped when Postgres is unreachable so `pnpm test` stays green without DBs).
- **Verify**: `pnpm -r run typecheck`, `pnpm lint`, `pnpm test` green (98 tests); `pnpm --filter @repo-memory/storage db:migrate` and `node app/dist/cli.js db migrate` both report "0 pending migrations" on the already-migrated DB.

#### 5.3 Observability & Metrics ✅ COMPLETE
- **Status:** Completed 2026-08-02. Verified end-to-end: a full scan under `PINO_LOG_LEVEL=debug` emits structured per-phase JSON logs (`discover`/`parse`/`resolve`/`embed`/`persist` with counts + timing), the CLI prints a `ScanReport` summary with a phase table, and `curl /metrics` shows counters/histograms moving between requests (API counter 1 → 6, latency histogram count 1 → 6).
- **`Logger`** (`packages/shared/src/logger.ts`): pino-based, `PINO_LOG_LEVEL` env (default `info`), writes JSON to stderr so CLI stdout stays machine-readable; supports `logger.info('msg')`, `logger.info({ field }, 'msg')`, `logger.error(err, 'msg')`, and `child()` bindings. All orchestrator/CLI/API/graph/storage/analysis `console.*` call sites (~75) converted to `logger.*` with contextual fields (`repoPath`, `commit`, `scanType`, `entityCount`, `durationMs`)
- **Scan telemetry**: orchestrator `beginScan`/`endPhase`/`finishScan` track per-phase counts + timing; every scan entry point now returns `ScanReport` (`packages/shared` type) with `filesDiscovered`, `filesParsed`, `entitiesExtracted`, `relationshipsExtracted`, `embeddingsGenerated`, `entitiesStored`, `relationshipsStored`, `phases[]`, `totalDurationMs`; CLI `scan` prints it as a table. Full-scan pipeline split into `resolveResults()` + `persistResolved()` so resolve and persist are timed independently
- **`MetricsRegistry`** (`packages/shared/src/metrics.ts`): counters/gauges/histograms with label support; `render()` emits Prometheus text format; `registerDefaultMetrics()` (idempotent) registers `repo_memory_entities_scanned_total`, `repo_memory_relationships_stored_total`, `repo_memory_embedding_calls_total`, `repo_memory_api_requests_total{method,path,status}`, `repo_memory_scan_duration_seconds`, `repo_memory_api_request_duration_seconds`, `repo_memory_queue_depth` (gauge; wired to the `jobs` table in 5.4), `repo_memory_last_scan_timestamp_seconds`
- **`GET /metrics`** endpoint (Hono, `METRICS_ENABLED=false` disables): Prometheus text format; histogram buckets for scan + API latency
- **Request logging middleware**: logs method/path/status/durationMs per request, echoes/generates `X-Request-Id` (correlation), feeds API request counters/histograms; API/health/metrics at `info`, static assets at `debug`
- **Tests**: `packages/shared/test/logger.test.ts` + `metrics.test.ts` (15 tests) — structured JSON output, Error serialization, child bindings, level filtering, `PINO_LOG_LEVEL` default, counter/gauge/histogram rendering, label escaping/sorting, default metric registration
- **Verify**: `pnpm -r run typecheck`, `pnpm lint`, `pnpm test` green (113 tests); full scan + `/metrics` verification above

#### 5.4 Reconciliation & Repair Jobs ✅ COMPLETE
- **Status:** Completed 2026-08-02. Verified end-to-end against the live dual store: deleted a Neo4j `Function` node manually → `jobs verify` reported it missing (entity delta 1, 6 relationships missing, `ok: false`) → `jobs repair` re-upserted the entity + 6 relationships and re-embedded 92 entities with null embeddings → a fresh `jobs verify` came back clean (`ok: true`, zero entity/relationship deltas, `entitiesWithoutEmbedding: 0`). All four API endpoints (`GET /api/jobs`, `GET /api/jobs/:id`, `POST /api/jobs/verify`, `POST /api/jobs/repair`) exercised against a live server, and the `repo_memory_queue_depth` gauge updates in `/metrics`.
- **`JobRepository`** (`packages/storage/src/job-repository.ts`): writes to the previously-unused `jobs` table — `create` (pending), `markRunning`/`markCompleted`/`markFailed` (with `started_at`/`completed_at` and JSON `result`/`error`), `findById`/`findAll`/`findByType`, and `countActive()` (pending + running) that feeds the `repo_memory_queue_depth` gauge
- **`verify` job** (`Orchestrator.verifyRepo`): compares PostgreSQL (source of truth) vs Neo4j and produces a `VerificationReport` (`packages/shared`): per-type entity/relationship counts, `missingInGraph` stable IDs, `orphanGraphNodes`, `missingRelationships`/`orphanRelationships`, `duplicateGraphNodes`, and `entitiesWithoutEmbedding`. A PG relationship only counts as "representable" when both endpoint stable IDs are real entities — PG rows whose `target_id` is unresolved expression text can never be graph edges and are excluded from the reconciliation contract (per-type raw counts still show them). Totals are derived from the reconciled key sets so the report is internally consistent; `ok` requires zero entity/relationship drift and zero orphans
- **`repair` job** (`Orchestrator.repairRepo`): re-syncs Neo4j from PostgreSQL — upserts entities missing from the graph (paged), deletes orphan graph nodes/edges, upserts representable relationships missing from the graph, re-embeds entities with null embeddings via `generateEntityEmbedding`, then re-runs verify and embeds the result as `verifyAfter` in the returned `RepairReport`
- **GraphClient additions** (`packages/graph/src/graph-client.ts`): `countEntities`/`countEntitiesByType`/`listEntityStableIds`, `countRelationships`/`countRelationshipsByType`/`listRelationshipKeys` (relationship type via `type(r)`, endpoints via node stable IDs), `deleteRelationship(sourceId, targetId, type, filePath)`; `upsertRelationship` now stamps `repoPath` on edges
- **Repository additions**: `EntityRepository.countByType`/`findAllStableIds`/`countWithoutEmbedding`/`findWithoutEmbedding`; `RelationshipRepository.countByType`/`findAllKeys`/`findAll`
- **Orchestrator job runner**: public `runJob(type, repoPath?)` creates the job row, persists status/result/error across the run, and keeps the queue-depth gauge in sync via `countActive()`; public `listScannedRepos()` returns every scanned repo path (for `--all-repos`)
- **CLI**: `repo-memory jobs verify|repair --repo <path>` with `--all-repos` support (reuses the orchestrator; `serve` passes its orchestrator into the API as the wired job runner)
- **API**: `GET /api/jobs` (`?type=`, `?limit=`), `GET /api/jobs/:id`, `POST /api/jobs/verify`, `POST /api/jobs/repair` — the POSTs run synchronously and return the completed job with its report (501 when no `runJob` callback is wired, keeping `@repo-memory/api` decoupled from the app orchestrator)
- **Tests**: `packages/storage/test/job-repository.test.ts` (8 tests via mock pool) — create + row mapping, commit/files params, mark running/completed/failed, findById/findAll, active-queue count
- **Verify**: `pnpm -r run typecheck`, `pnpm lint`, `pnpm test` green (121 tests); the delete-a-node → verify → repair → verify cycle above against real Postgres + Neo4j

#### 5.5 Streaming Analysis for Repository Scale ✅ COMPLETE
- **Status:** Completed 2026-08-02. Verified live against the monorepo (1524 entities, 4748 relationships): streaming dead-code/boundaries return byte-identical results to the in-memory versions (dead=66/exported=88, boundaries 844 edges / 195 violations), and `ANALYSIS_BATCH_SIZE` is a live memory knob — `pnpm bench --batch 1000` peaked at ~182MB RSS vs ~249MB at batch 5000, roughly flat as analysis runs sequentially. All analysis API endpoints stream and match CLI output.
- **`streaming.ts`** (`packages/analysis/src/streaming.ts`): new bounded-window engine. `PagedSource<T>` contract (`page(offset, limit)`) + `forEachPage` (stops on a short page) + `resolveBatchSize` (reads `ANALYSIS_BATCH_SIZE`, default 5000). `streamDeadCode` (3 passes: compact entity index + roots → outgoing adjacency of bare stable IDs → re-stream entities emitting full objects only for dead symbols) and `streamBoundaries` (entity lookup maps → cross-domain edge stream) — only one window of each store is ever resident, and the report output is the only full-object retention
- **`findByTypesPaged(types, limit, offset)`** (`packages/storage/src/relationship-repository.ts`): deterministic paged window over a relationship-type set ordered by `(source_id, id)`, backing every streaming analysis source
- **`ChangeAnalyzer`** (`packages/analysis/src/change.ts`): `ChangeDataProvider` gained optional `entityPage`/`relationshipPage`/`entityByStableId`; `computeFileRisk` and `detectDrift` now run entirely over paged sources (dead-code + boundaries computed from the same streams), holding entities per-file as bare stable IDs; `computeEntityChange` uses `entityByStableId` when provided (falls back to a full load otherwise). Full-array providers are transparently sliced into pages, so existing array-based tests/consumers keep working
- **Orchestrator**: `getDeadCodeReport()` and the new `getBoundariesReport()` stream via `findByTypesPaged`; the `ChangeAnalyzer` provider wires `entityPage`/`relationshipPage`/`entityByStableId`
- **API**: `/api/analysis/dead-code`, `/api/analysis/boundaries` stream with an optional `?batchSize=` param; risk/drift/churn endpoints inherit the paged analyzer
- **Benchmark harness**: `pnpm bench` (`app/src/bench.ts`, also root `bench` passthrough) — `--repo <path>` (default cwd), `--full` to time a full scan first, `--batch N`; prints per-analysis duration, result count, and RSS before→after plus peak
- **Tests**: `packages/analysis/test/streaming.test.ts` (9 tests) — `forEachPage` windowing/short-page stop, `resolveBatchSize` env/arg precedence, streaming↔in-memory dead-code and boundaries parity, batch-size independence, non-entity endpoint exclusion; plus a paged-vs-array `computeFileRisk` parity test in `change.test.ts`
- **Verify**: `pnpm -r run typecheck`, `pnpm lint`, `pnpm test` green (131 tests); live parity script + live server API checks above

#### 5.6 Live File Watching
- Wire the existing `FileWatcher` (chokidar) into the orchestrator: on `file:change`/`file:add`/`file:delete`, run the same path the incremental scan uses for a single file (`processChanges` single-file path, `handleFileDeletion`)
- New CLI mode: `repo-memory watch --repo <path>` — starts a server + watcher, updates the graph on every edit (debounced)
- API: `GET /api/status` returning watched repo + last scan time (frontend "live" indicator)
- **Verify**: `watch` a small repo, edit a function, confirm the entity updates and dependents reflect the change without a manual scan

#### 5.7 Multi-Language Parsers (Go, Rust, Java)
- Add grammar entries for `go`, `rust`, `java` to `tree-sitter-init.ts` `PARSER_CONFIGS` (from `tree-sitter-wasms` bundle where available; verify ABI against pinned `web-tree-sitter@0.22.6`)
- **`GoExtractor`** (`extractors/go.ts`): funcs, methods, structs, interfaces, imports, calls, packages (embed the existing `BaseExtractor` helpers)
- **`RustExtractor`** (`extractors/rust.ts`): functions, structs, enums, traits, impls, modules, calls, imports
- **`JavaExtractor`** (`extractors/java.ts`): classes, interfaces, enums, methods, constructors, annotations, imports, calls
- Register all three via `registerLanguageExtractor`; extend `getLanguageFromFilePath`/`shouldParseFile`/`getGrammarKeyFromFilePath`
- Add `Language.GO`/`LANGUAGE_RUST`/`LANGUAGE_JAVA` to `packages/shared`
- **Verify**: parse fixture Go/Rust/Java projects; entity + relationship counts sane; unit tests from 5.1 extended to the new extractors

**Execution Order:** 5.1 → 5.2 → 5.3 → 5.4 → 5.5 → 5.6 → 5.7

**Dependencies/notes:**
- 5.1 is foundational — every later milestone adds tests through the framework it establishes
- 5.2 must land before 5.4 (repair jobs write schema-grounded data) and before any future migration
- 5.3's structured logger is the substrate for 5.4 job status and 5.5 benchmark reporting
- 5.7 is independent of 5.2–5.6 and can be parallelized against 5.5/5.6

## Non-Goals
- Replacing the source code repository itself
- Making visualization the primary interface
- Requiring full rescans for normal updates
- Limiting the system to dependency diagrams only

## Success Criteria
The engine is successful when:
- New commits are processed incrementally and accurately
- Users can ask architectural and impact questions with traceable answers
- Context packs reduce manual repository searching
- History and evolution are preserved across time
- The graph remains queryable at repository scale
- AI agents can retrieve focused context without broad rescans

## Open Technical Questions
These are the main areas to resolve before implementation hardens.

### 1. Data Consistency & Syncing
- Three-store synchronization: how should updates stay consistent across Neo4j, PostgreSQL, and pgvector if ingestion fails midway?
- Neo4j versioning: should history be modeled as snapshots, valid-time properties, or a hybrid of both?
- Entity identity: how should the engine preserve identity across renames, moves, and file splits?

### 2. Analysis & Parsing Depth
- Cross-file symbol resolution: should the engine build its own symbol index, or integrate LSIF / SCIP style indexes where available?
- Dependency resolution: should imports be resolved only within the repo, or also into third-party packages and external code?
- Heuristic extraction: should purpose and responsibility come from LLM summarization, static heuristics, or a mixed strategy?

### 3. Incremental Strategy & Performance
- Ripple effects: how far should re-analysis propagate when a type or signature change affects downstream files?
- Local vs. commit state: when uncommitted changes conflict with the last commit, which view should the engine prioritize for queries?

### 4. Semantic & AI Integration
- Embedding granularity: should embeddings be stored at file, class, function, or mixed levels?
- Context pack constraints: how should the engine rank, trim, and summarize when the relevant neighborhood exceeds the token budget?
- Hybrid search: how should graph traversal and semantic similarity be combined for compound questions?

### 5. Deployment & Scalability
- Local resource footprint: what baseline hardware should be assumed for running graph storage, metadata storage, and embeddings locally?
- Multi-repo support: should the engine remain repo-local initially, or support cross-repository ownership and call mapping from the start?

### 6. User Experience
- Initial indexing: should the API remain partially functional during large first-time scans?
- Conflict resolution: should humans be able to correct extracted entities and relationships when confidence is low?

## Suggested Defaults for Phase 1
- Use transactional ingestion orchestration with idempotent writes and compensating cleanup for partial failures.
- Start with valid-time edge properties plus change snapshots for auditability.
- Preserve entity identity with a stable internal ID backed by rename and move heuristics.
- Limit dependency resolution to the repository plus explicit external package metadata.
- Use a hybrid heuristic-first approach for semantic metadata, then enrich with LLM summaries where helpful.
- Re-analyze only directly impacted files plus a bounded downstream ripple set.
- Prioritize the working tree for local AI queries, while exposing commit-state views as a separate lens.
- Store mixed-granularity embeddings, starting with file-level and selective function-level chunks.
- Build hybrid search by intersecting graph traversal candidates with semantic similarity scores.
- Keep initial deployment lightweight enough for a standard developer machine, with optional external services for scale.
- Treat initial indexing as partially usable, not blocking.
- Allow human correction of graph data through an explicit review and override path.
