# Changelog

All notable changes to RepoMemory will be documented in this file.

## [0.12.0] - 2026-08-02

### Added (M15) - Live File Watching (5.6)
- **Orchestrator watch mode** (`app/src/orchestrator.ts`): `startWatching({ debounceMs? })` / `stopWatching()` create and own the existing `FileWatcher` (chokidar). Each `file:change`/`file:add`/`file:delete` event is queued and flushed on a debounce window through `processWatchChanges`, which reuses the exact incremental single-file path (`processChanges` + `handleFileDeletion`) but skips commit recording (the working tree is not a commit). `touchRepoState()` bumps `repo_state.last_scan_at` so live status reflects edits; `close()` now stops the watcher
- **Path normalization**: `FileWatcher.getRelativePath` now returns forward-slash relative paths, matching the git-derived paths stored in the database (fixes mismatch on Windows where chokidar emitted backslash paths)
- **API**: `GET /api/status` returns `{ repoPath, watching, lastScanAt, pendingChanges }` via an optional `getStatus` provider on `ApiConfig` (defaults to `watching: false` when unwired) — `RepoStatus` added to `packages/shared`
- **CLI**: `repo-memory watch --repo <path> [--port] [--host] [--debounce <ms>]` — seeds the graph with a full scan on first watch (when no entity data exists), starts the watcher, then serves the API with status wired. Graceful SIGINT/SIGTERM shutdown
- **Frontend**: header "live" dot indicator (`#liveIndicator`) polls `/api/status` every 5s, showing "Live · synced <timeAgo>" plus a pending-changes count while watching
- **Tests**: `packages/ingestion/test/file-watcher.test.ts` (2 tests, real chokidar temp-dir integration: add/change/delete events + relative-path normalization) and `packages/api/test/status.test.ts` (2 tests: default `watching:false` payload and provider passthrough) — 4 new tests
- **Verified end-to-end**: watched a scratch repo; adding a function (`div`) to a `.ts` file appeared via `GET /api/entities` with no manual scan; editing an importer and deleting `main.ts` both propagated to the graph within the ~500ms debounce window; `lastScanAt` updated on each watch scan
- `pnpm typecheck`, `pnpm lint`, and `pnpm test` are green (135 tests)

## [0.11.0] - 2026-08-02

### Added (M14) - Streaming Analysis for Repository Scale (5.5)
- **`packages/analysis/src/streaming.ts`**: bounded-window analysis engine. `PagedSource<T>` contract (`page(offset, limit)`) with `forEachPage` (stops on a short page), and `resolveBatchSize` (explicit arg > `ANALYSIS_BATCH_SIZE` env > default 5000). `streamDeadCode` runs 3 passes (compact entity index + roots → outgoing adjacency of bare stable IDs → re-stream entities, emitting full objects only for dead symbols); `streamBoundaries` builds compact lookup maps then streams only cross-domain edges. Only one window of each store is resident; the report output is the only full-object retention
- **`findByTypesPaged(types, limit, offset)`** (`packages/storage/src/relationship-repository.ts`): deterministic paged window over a relationship-type set (`type IN (...)`, optional repoPath, ordered by `(source_id, id)`), backing every streaming analysis source
- **`ChangeAnalyzer`** (`packages/analysis/src/change.ts`): `ChangeDataProvider` gained optional `entityPage`/`relationshipPage`/`entityByStableId`; `computeFileRisk` and `detectDrift` now run entirely over paged sources (dead-code + boundaries computed from the same streams, entities held per-file as bare stable IDs); `computeEntityChange` uses `entityByStableId` when provided. Array-based providers are transparently sliced into pages, so existing tests/consumers keep working
- **Orchestrator**: `getDeadCodeReport()` and the new `getBoundariesReport()` stream via `findByTypesPaged`; the `ChangeAnalyzer` provider wires `entityPage`/`relationshipPage`/`entityByStableId`
- **API**: `/api/analysis/dead-code` and `/api/analysis/boundaries` stream with an optional `?batchSize=` param; risk/drift/churn endpoints inherit the paged analyzer; cross-repo CLI `query dead-code --all-repos` streams instead of loading everything
- **Benchmark harness**: `pnpm bench` (`app/src/bench.ts`, root `bench` passthrough) — `--repo <path>` (default cwd), `--full` to time a full scan first, `--batch N`; prints per-analysis duration, result count, and RSS before/after plus peak
- **Tests**: `packages/analysis/test/streaming.test.ts` (9 tests: `forEachPage` windowing/short-page stop, `resolveBatchSize` env/arg precedence, streaming↔in-memory dead-code and boundaries parity, batch-size independence, non-entity endpoint exclusion) plus a paged-vs-array `computeFileRisk` parity test in `change.test.ts` — 10 new tests
- **Verified end-to-end** against the monorepo (1524 entities, 4748 relationships): streaming dead-code/boundaries byte-identical to the in-memory versions (dead=66/exported=88; boundaries 844 edges / 195 violations / 8 domains); `pnpm bench --batch 1000` peaks at ~182MB RSS vs ~249MB at batch 5000, confirming `ANALYSIS_BATCH_SIZE` bounds peak memory roughly flat with repo size. All analysis API endpoints stream and match CLI output
- `pnpm typecheck`, `pnpm lint`, and `pnpm test` are green (131 tests)

## [0.10.0] - 2026-08-02

### Added (M13) - Reconciliation & Repair Jobs (5.4)
- **`JobRepository`** (`packages/storage/src/job-repository.ts`): full CRUD over the existing `jobs` table (which was previously never written to) — `create` (pending), `markRunning`/`markCompleted`/`markFailed` with `started_at`/`completed_at`, `findById`/`findAll`/`findByType`, and `countActive` (pending + running) that feeds the `repo_memory_queue_depth` gauge
- **`verify` job**: compares PostgreSQL (source of truth) vs Neo4j — per-type entity and relationship counts, entities missing from the graph, orphan graph nodes (no PG row), missing/orphan relationships (a PG relationship is "representable" in the graph only when both endpoint stable IDs are real entities; raw-expression targets are excluded), duplicate graph stable IDs, and entities with null embeddings. Produces a `VerificationReport` (`packages/shared`) with per-type deltas, totals, and an `ok` flag
- **`repair` job**: re-syncs Neo4j from PostgreSQL — upserts entities and relationships missing from the graph, deletes orphan graph nodes/edges, re-embeds entities with null embeddings, then re-verifies. Returns a `RepairReport` with counts plus the post-repair `verifyAfter` report
- **GraphClient additions** (`packages/graph/src/graph-client.ts`): `countEntities`/`countEntitiesByType`/`listEntityStableIds`, `countRelationships`/`countRelationshipsByType`/`listRelationshipKeys` (via `type(r)` and endpoint stable IDs), `deleteRelationship`; `upsertRelationship` now stores `repoPath` on edges
- **Orchestrator job runner**: `runJob(type, repoPath?)` persists status/result/error and keeps the `repo_memory_queue_depth` gauge in sync; `listScannedRepos()` lists every scanned repo
- **CLI**: `repo-memory jobs verify --repo <path>` / `repo-memory jobs repair --repo <path>` (both support `--all-repos`); `serve` wires its orchestrator into the API as the job runner
- **API**: `POST /api/jobs/verify`, `POST /api/jobs/repair` (run synchronously, return the completed job with its report), `GET /api/jobs` (optional `?type=`/`?limit=`), `GET /api/jobs/:id`. POST endpoints respond 501 when no job runner is wired
- **Tests**: `packages/storage/test/job-repository.test.ts` (create/mark* lifecycle, JSON result persistence, findById/findAll/findByType, active-queue counting via mock pool) — 8 new tests
- **Verified end-to-end**: deleted a Neo4j `Function` node manually → `verify` reported it missing (entity delta 1, 6 relationships missing, `ok: false`) → `repair` re-upserted the entity + 6 relationships and re-embedded 92 entities → `verify` clean (`ok: true`, zero deltas, `entitiesWithoutEmbedding: 0`); all four API endpoints exercised live against the running server, with the queue-depth gauge visible in `/metrics`
- `pnpm typecheck`, `pnpm lint`, and `pnpm test` are green (121 tests)

### Added (M12) - Observability & Metrics (5.3)
- **Structured logging**: `Logger` (`packages/shared/src/logger.ts`) wraps pino with `PINO_LOG_LEVEL` env (default `info`); logs JSON lines to stderr so CLI stdout stays machine-readable. Supports plain messages, contextual bindings, `Error` serialization, and `child()` bindings. ~75 `console.*` call sites across orchestrator, CLI, API, graph, storage, and analysis converted to `logger.*`
- **Scan telemetry**: the orchestrator records per-phase events (`discover` → `parse` → `resolve` → `embed` → `persist`) with entity/relationship counts and timing, and returns a `ScanReport` (new type in `packages/shared`) from every scan entry point (`scanFullRepository`/`scanIncremental`/`scanFromCommit`/`scanWorkingTree`). The CLI prints a human-readable report (type, commit, file/entity/relationship/embedding counts, per-phase table)
- **Prometheus metrics**: `MetricsRegistry` (`packages/shared/src/metrics.ts`) with counters/gauges/histograms + label support, rendering the Prometheus text exposition format. Standard set: `repo_memory_entities_scanned_total`, `repo_memory_relationships_stored_total`, `repo_memory_embedding_calls_total`, `repo_memory_api_requests_total` (method/path/status labels), `repo_memory_scan_duration_seconds` (histogram), `repo_memory_api_request_duration_seconds` (histogram), `repo_memory_queue_depth` (gauge, wired in 5.4), `repo_memory_last_scan_timestamp_seconds` (gauge)
- **`GET /metrics`**: Prometheus endpoint on the API server (gate with `METRICS_ENABLED=false`), served as `text/plain; version=0.0.4`
- **Request logging middleware**: Hono middleware capturing method/path/status/durationMs per request, `X-Request-Id` echo/correlation (client header or generated UUID), and feeding the API request counters/histograms. API/health/metrics requests log at `info`; static assets at `debug`
- **Tests**: `packages/shared/test/logger.test.ts` (structured JSON output, Error serialization, child bindings, level filtering, `PINO_LOG_LEVEL` default) and `packages/shared/test/metrics.test.ts` (counters, gauges, histogram buckets/`_sum`/`_count`, label escaping/sorting, default metric registration) — 15 new tests
- `pnpm typecheck`, `pnpm lint`, and `pnpm test` are green (113 tests)

## [0.9.0] - 2026-08-02

### Added (M11) - Versioned Schema Migrations (5.2)
- **Migration runner**: `MigrationRunner` in `packages/storage/src/migrations/runner.ts` creates the `schema_migrations` ledger table (`id`, `name`, `applied_at`), then applies pending migrations in ascending id order — each inside its own transaction with the ledger row committed atomically (failed migrations roll back without a partial record). Returns the applied `MigrationResult[]`
- **Numbered migrations** replacing the monolithic `SCHEMA_SQL` blob in `packages/storage/src/schema.ts`:
  - `001-init` — extensions, base tables (`entities`, `relationships`, `commits`, `file_changes`, `jobs`, `repo_state`), base indexes
  - `002-repo-path-scoping` — `repo_path` columns, repo-scoped relationships unique constraint, repo-path indexes
  - `003-embeddings` — `entities.embedding vector(768)` + hnsw cosine index
  - `004-id-lengths` — widen `relationships.source_id`/`target_id` to VARCHAR(1000)
  - Every migration is idempotent (`IF NOT EXISTS` / guarded `DO` blocks), so existing installs back-fill safely
- **`db:migrate` fix**: real `packages/storage/src/migrate.ts` entrypoint (reads `PG_HOST`/`PG_PORT`/`PG_DATABASE`/`PG_USER`/`PG_PASSWORD`); storage script switched from the broken `node --loader ts-node/esm` to `tsx src/migrate.ts`
- **CLI**: new `repo-memory db migrate` command runs pending migrations against the configured Postgres
- **Tests**: `packages/storage/test/migrations.test.ts` (registry ordering/contiguity + runner apply/skip logic via mock pool) and `migrations-integration.test.ts` (fresh-database apply → schema assertions → no-op re-run against a dedicated `repo_memory_test` database; auto-skips when Postgres is unreachable)
- `pnpm typecheck`, `pnpm lint`, and `pnpm test` are green (98 tests)


### Added (M10) - Test Foundation & Quality Gates (5.1)
- **Vitest test framework**: workspace-wide test runner (`pnpm test`, `pnpm test:watch`) with root `vitest.config.ts` wiring `@repo-memory/*` package aliases; per-package `test` scripts for analysis, api, ingestion, shared
- **Unit tests** (90 tests across 12 files):
  - `packages/shared`: entity/relationship/language enum constant values
  - `packages/analysis`: stable-ID generation (`generateEntityStableId`/`generateFileStableId`), `createFileEntity`, `resolveImportPath` (relative / dir-index / unique-basename / package→index / parent traversal), `SymbolIndex` lookup scope chain (same-file → import → global-unique → ambiguous), `RelationshipResolver` metadata (`resolvedBy`, `resolutionHint`, `unresolvedTarget`, already-resolved), dead-code detection (entrypoint/test roots, propagation, exported-but-unused, FILE/CONFIG ignored), domain/role inference + `applyDomainMetadata`/`parseDomainConfig`, boundary validation (strict vs imports-only, wildcards), `ChangeAnalyzer` churn/risk/drift against synthetic rows, and Tree-sitter extractors for TypeScript/Python fixtures (classes, interfaces, enums, methods, endpoints, models, IMPORTS/CALLS/CONTAINS/EXPORTS)
  - `packages/api`: `QaService` intent classification + compound-question splitting + `stripQuestion` tokenization; `ContextPackBuilder` metadata/package inference, recent-change filtering, and token-budget trimming
  - `packages/ingestion`: `GitOperations.parseNumstatOutput` (modified/create/delete, rename summaries, binary, empty)
- **ESLint flat config**: `eslint.config.js` (typescript-eslint + eslint-config-prettier + Node globals), Prettier config, wired into `pnpm lint`; fixed pre-existing unused-import/unused-var/unnecessary-escape issues across analysis, api, storage, graph, and app
- **CI**: GitHub Actions workflow (`.github/workflows/ci.yml`) with PostgreSQL + Neo4j service containers — install → typecheck → lint → build → test → self-scan smoke test
- `pnpm typecheck`, `pnpm lint`, and `pnpm test` are green



### Added (M8) - Workspace-Wide Workflows (cross-repo)
- **Workspace API**: New `/api/workspace/*` endpoints that read across every scanned repository without changing the per-repo serving model:
  - `GET /api/workspace/repos` — distinct repos with entity count, commit count, last-scan commit / timestamp
  - `GET /api/workspace/entities` — cross-repo entity list (optional `repoPath` filter)
  - `GET /api/workspace/entities/search/:query` — cross-repo search; results carry `repoPath`
  - `GET /api/workspace/entities/type/:type` — cross-repo type listing
  - `GET /api/workspace/qa/ask` — cross-repo QA with repo-annotated answers; ambiguous matches aggregate per repo (optional `repoPath` scopes to one repo)
- **Unfiltered repositories**: `EntityRepository`, `RelationshipRepository`, and `CommitRepository` treat an empty `repoPath` as "no filter"; `findSimilar`/`findByEmbedding`/`findCommitsForFile` are unfiltered-safe
- **`Entity.repoPath`** mapped through `entity-repository.ts`, `graph-client.ts` (`mapRecordToEntity`), and `commit-repository.ts`
- **`QaService` workspace mode**: constructed with a `workspace` flag; `resolveCandidates` returns repo-qualified candidates, `workspaceAmbiguityAnswer` aggregates per repo, `entityPath` renders `repo:file` paths
- **CLI**: `repo-memory workspace repos` and `--all-repos` flag on `query search` / `query dead-code` for cross-repo reporting
- **Frontend repo dropdown**: `#repoFilter` select in the header ("All repos" or a specific repo), `repo-tag` styling, and `currentRepo` filtering across entity/search/commits/architecture loaders

### Added (M9) - Entity-Change Correlation (churn, risk, drift)
- **`ChangeAnalyzer`** (`packages/analysis/src/change.ts`): computes per-file churn (`computeFileChurn` with adds + k·deletes scoring and recent-window support), explainable 0-100 file risk (`computeFileRisk` combining churn, inbound fan-out, boundary violations, dead-code flags, staleness), entity change info (`computeEntityChange`: commit count, first/last seen, staleness, owning-file churn), and drift signals (`detectDrift`: test-gaps, recent boundary violations, unstable public surfaces). Backed by a `ChangeDataProvider` interface so the analysis package stays free of pg/storage dependencies
- **Storage**: `CommitRepository.getFileChurn` (aggregate over `file_changes`) and `getLastCommitDate`
- **API**: `GET /api/analysis/churn?limit=`, `GET /api/analysis/risk`, `GET /api/analysis/risk/:stableId` (cross-repo entity lookup), `GET /api/analysis/drift`
- **QA intents**: `churn` ("which files change the most?") and `drift` ("is the architecture drifting?") handled in `answerRepoLevel`
- **CLI**: `repo-memory query churn [limit]`, `repo-memory query risk <stableId>`; orchestrator `getChurn`/`getFileRisk`/`getRisk`/`getDrift`
- **Orchestrator change provider**: `changeAnalyzerFor(repoPath)` wires `fileChurnRows`, `entities`, `relationships`, and `lastCommitDate` to the storage layer

### Added (Frontend) - Analysis, Ask, and Change panels
- **Analysis tab**: new header nav tab with sub-reports for Churn, Risk, Drift, Dead code, Owners, and Bounds (boundaries), rendering severity chips, risk/churn bars, and per-repo tags
- **Ask tab**: natural-language QA input with suggestion chips hitting `POST /api/workspace/qa/ask` (repo-scoped when a specific repo is selected); renders intent, clickable entity (opens the detail panel), answer, and evidence
- **Change Analysis section** in the entity detail panel: commits touching the entity, first/last seen commit, staleness, and owning-file churn bar via `GET /api/analysis/risk/:stableId`
- **Backend support**: `GET /api/workspace/entities/:stableId` for cross-repo entity lookup (enables QA/detail links for any repo)

### Fixed
- `EntityRepository.findSimilar` / `findByEmbedding` threw `42P18: could not determine data type of parameter $2` when run against an unfiltered (empty `repoPath`) repository: the unfiltered SQL referenced `$1,$3,$4` while passing three params, leaving `$2` declared-but-unused. Renumbered the unfiltered branches to use `$2`/`$3` for threshold/limit

## [0.6.0] - 2026-08-01

### Added (M7)
- **Query Orchestration**: `QaService.ask` now splits compound questions (`and`/`then`/`;`/`.`) and answers each fragment, inheriting the entity from a prior fragment. New intents: `impact` (direct + transitive dependents, affected files, risk score), `path` (shortest path between two entities), `changelog` (recent commits touching a file), `file-deps` (imports + referenced symbols for a file)
- **Graph Traversal Additions**: `GraphClient.findTransitiveDependents()` and `findShortestPath()` (direction-aware via relationship source identity)
- **File→Symbol Graph Connectivity**: the orchestrator re-anchors `EXPORTS`/module `IMPORTS` source IDs from the raw file-path string to the File entity's stable ID, and synthesizes `File -[CONTAINS]-> symbol` edges, so file nodes connect to their symbols in Neo4j
- **Two-Phase Persistence**: full scans store all entity nodes before any relationship, so graph relationship upserts no longer silently drop edges to not-yet-stored targets
- **Endpoint/File Entity Resolution**: HTTP-verb extraction (`POST /users/:id`) and file-path token extraction are tried before the generic symbol search; second-entity resolution for path questions scans from the end of the question and avoids the first entity's own tokens

### Changed (M7)
- `/api/analysis/impact/:stableId` now uses `findTransitiveDependents` (was `findTransitiveDependencies`, wrong direction)
- Path traversal includes `CONTAINS`/`EXPORTS` edges; dependency/dependent/impact queries keep the real dependency edge set

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

### Added (M6)
- **Natural-Language QA**: `QaService` in `packages/api/src/qa.ts` classifies questions into intents (dependencies / dependents / location / ownership / dead code / tests / info) and returns structured answers with evidence. New endpoint `POST /api/qa/ask`
- **Commit History on Scans**: Full/incremental/working-tree scans now ingest the last 100 commits and annotate each entity with `firstSeenCommit`/`lastSeenCommit`
- **Real File-Change Counts**: Git ingestion switched from `--name-status` to `--numstat --summary` (with a parser for both line formats), so `file_changes` carry true add/delete counts and added/modified/deleted/renamed statuses

### Changed (M6)
- `CommitRepository` upsert now `ON CONFLICT (commit_hash, file_path) DO UPDATE` so re-scans refresh stale change counts
- Graph dependency/dependent/transitive queries now include `HANDLES`, so API routes appear as callers of their handlers
- Frontend contract fixes: commit list reads `date`, file-change rows read `status`, context pack panel renders the structured `ContextPack` shape

### Fixed (M6)
- `extractReferencesFromNode` emitted self-referencing `REFERENCES` for function/variable names because `childForFieldName` returns a distinct node object (identity comparison never matched). Names are now compared by node position
- QA ownership answers matched the wrong file; questions naming a file path now resolve the exact file before falling back to generic entity search

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
