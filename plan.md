# Repository Memory Engine Plan

# Phase 2 session: opencode -s ses_051b766b4ffePsBsCVmp6HYZsF

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

### Phase 3: Multi-Language Coverage
- Add parser adapters for more languages
- Improve API, test, config, and model detection
- Strengthen ownership and domain inference
- Add architecture boundary validation

### Phase 4: AI and Developer Workflows
- Ship traversal, impact analysis, and dead code detection
- Add question-answer APIs for agents
- Build progressive exploration and architecture views
- Add confidence scoring and provenance

### Phase 5: Hardening
- Improve performance on large repositories
- Add reconciliation and repair jobs
- Add observability, metrics, and quality gates
- Validate against real-world repositories

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
