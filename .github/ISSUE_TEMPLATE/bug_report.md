---
name: Bug report
about: Something broken in scan, query, serve, watch, MCP, or the frontend
title: "[bug] "
labels: bug
---

## What happened

## Steps to reproduce

1. Command(s) run (e.g. `scan --repo ... --full`):
2. Repo language(s), rough size:
3. Expected vs actual:

## Environment

- RepoMemory version / commit:
- Node (`node -v`), pnpm (`pnpm -v`), Docker (`docker -v`):
- OS:
- PostgreSQL: compose service or external? (`SELECT version();` if external)
- `EMBEDDING_PROVIDER` / model cache present (`./models`)?

## Logs

Paste relevant log lines (stderr JSON is fine) or `jobs verify` output.
