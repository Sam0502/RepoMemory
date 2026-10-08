# RepoMemory runtime image: built CLI + API + MCP over stdio/HTTP.
# PostgreSQL itself is NOT in this image — run it via docker-compose
# (the `postgres` service) or point PG_HOST at an external database.
#
#   docker build -t repo-memory .
#   docker run --rm -e PG_HOST=host.docker.internal repo-memory scan --repo /repo
#
# The repository to scan is mounted at /repo (read-only is fine for
# scan/query; watch mode needs write access for nothing — it only reads).

FROM node:20-slim AS deps
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN npm install -g pnpm@9
WORKDIR /repo-memory
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY app/package.json app/package.json
COPY packages/shared/package.json packages/shared/package.json
COPY packages/ingestion/package.json packages/ingestion/package.json
COPY packages/analysis/package.json packages/analysis/package.json
COPY packages/storage/package.json packages/storage/package.json
COPY packages/services/package.json packages/services/package.json
COPY packages/api/package.json packages/api/package.json
COPY packages/mcp/package.json packages/mcp/package.json
RUN pnpm install --frozen-lockfile

FROM deps AS build
COPY . .
RUN pnpm -r run build
# Bake the default ONNX model in so the image works without a download step.
# Override at runtime with a -v models-cache:/repo-memory/models volume, or
# set EMBEDDING_PROVIDER=placeholder to skip semantic search entirely.
RUN pnpm download-model || (echo "model download skipped (offline build)" && mkdir -p models)
# Drop dev-only packages (typescript, vitest, tsup, tsx, @types) — dist/ is prebuilt.
RUN pnpm prune --prod

FROM node:20-slim AS runtime
ENV NODE_ENV=production
# In-container Postgres defaults (compose service name + internal port).
# Override with -e PG_HOST=... PG_PORT=... for external databases.
ENV PG_HOST=postgres
ENV PG_PORT=5432
ENV PG_DATABASE=repo_memory
ENV PG_USER=repo_memory
# No default password baked in — pass -e PG_PASSWORD=... at runtime
# (docker-compose.yml already does).
WORKDIR /repo-memory
COPY --from=build /repo-memory/package.json /repo-memory/pnpm-workspace.yaml /repo-memory/pnpm-lock.yaml ./
COPY --from=build /repo-memory/app ./app
COPY --from=build /repo-memory/packages ./packages
COPY --from=build /repo-memory/web ./web
COPY --from=build /repo-memory/node_modules ./node_modules
COPY --from=build /repo-memory/models ./models
RUN ln -s /repo-memory/app/dist/cli.js /usr/local/bin/repo-memory
EXPOSE 3000
ENTRYPOINT ["node", "app/dist/cli.js"]
CMD ["--help"]
