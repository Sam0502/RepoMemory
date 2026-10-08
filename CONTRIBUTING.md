# Contributing to RepoMemory

Thanks for helping out. This guide covers the contributor path end to end.
If you just want to **use** RepoMemory, follow the Quick Start in `README.md`
— you only need this document if you're changing code.

## Prerequisites

- Node.js 20+
- pnpm (`npm install -g pnpm`)
- Docker (for PostgreSQL + pgvector)
- Git

## First-time setup

```bash
pnpm setup            # install → start Postgres → migrate → build → download ONNX model
```

What that does, step by step (see `scripts/setup.mjs`):

1. Checks Node/pnpm/Docker versions
2. `pnpm install`
3. `docker compose up -d postgres` and waits for `pg_isready`
4. `node app/dist/cli.js db migrate` (or `pnpm --filter @repo-memory/storage db:migrate`)
5. `pnpm build`
6. Downloads the ONNX embedding model into `./models` (skip with `--skip-model`)

To scan your first repo afterwards:

```bash
node app/dist/cli.js scan --repo /path/to/repo --full
node app/dist/cli.js serve --repo /path/to/repo --port 3000
```

## Daily development

```bash
pnpm dev               # API server with live reload (tsx watch)
pnpm test              # full Vitest suite (PG integration tests auto-skip without a DB)
pnpm test:watch        # watch mode
pnpm typecheck         # tsc --noEmit, all 8 projects
pnpm lint              # ESLint, zero warnings allowed
pnpm build             # tsup bundles, all packages
pnpm bench --repo /path/to/repo   # streaming-analysis benchmark (app/scripts/bench.ts)
```

PostgreSQL for tests: the suite connects with the standard `PG_*` variables
(defaults: `localhost:5433`, `repo_memory` / `repo-memory-password`) and
creates isolated `repo_memory_*_test` databases. Point them at any PG16 +
pgvector instance, e.g. the compose service.

## Quality gate

Every PR must pass the same gate CI runs:

```bash
pnpm typecheck && pnpm lint && pnpm build && pnpm test
```

Conventions:

- TypeScript strict, ESM (`import ... from './x.js'` with extensions)
- ESLint max-warnings 0 — fix, don't suppress
- New storage SQL: add a skip-guarded integration test (see
  `packages/storage/test/traversal-integration.test.ts`), each with its own
  `repo_memory_*_test` database — never share one across files (parallel workers)
- Public API changes (HTTP routes, MCP tools, CLI commands): update
  `README.md` endpoint lists, `docs/system-overview.md` if user-facing, and
  `CHANGELOG.md` (add to the top `[Unreleased]` section)
- Keep `packages/*/src/index.ts` barrels minimal — internal helpers stay
  unexported; `dependencies` stay runtime-only, `tsx`/`tsup`/`vitest` stay dev-only

## Project layout (short version)

See `AGENTS.md` for the full map. The one rule that matters: **PostgreSQL is
the only store**. Graph traversal lives in `TraversalService`
(`packages/storage/src/traversal.ts`) as recursive CTEs. There is no second
database — don't add one without discussing it first.

## Pull requests

1. Fork, branch from `main` (`feat/<what>`, `fix/<what>`, `docs/<what>`)
2. Keep PRs focused; one concern per PR
3. Fill in the PR template (what / how verified / docs updated?)
4. Ensure the quality gate is green locally — CI runs the same commands

## Releases (maintainers)

1. Bump versions: root + `packages/*/package.json` + `app/package.json`
   (keep them in lockstep, currently `0.1.0`), update `CHANGELOG.md`
2. Tag: `git tag vX.Y.Z && git push origin vX.Y.Z`
3. `.github/workflows/release.yml` builds everything, creates the GitHub
   release with `dist/` bundles attached, and — only when the corresponding
   secrets exist — publishes `@repo-memory/app` to npm (`NPM_TOKEN`) and the
   Docker image to GHCR (`GITHUB_TOKEN` covers it)
4. To publish to npm manually: `pnpm build && npm publish --workspace @repo-memory/app`
   (requires removing `"private": true` first — see `app/package.json`)

## Security

- Never commit `.env` files, API keys, or tokens. `.env.example` holds
  defaults only.
- Production deployments: change `PG_PASSWORD`, set
  `REPO_MEMORY_API_TOKEN`, bind `--host 127.0.0.1` (or a reverse proxy),
  review `CORS_ORIGIN`. See "Production notes" in `README.md`.
- Report vulnerabilities privately: open a GitHub issue titled
  `[security]` with minimal details and a contact, or email the maintainers.
