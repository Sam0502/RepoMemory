import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts', 'src/cli.ts'],
  format: ['esm'],
  dts: true,
  // @repo-memory/api and @repo-memory/mcp are optional dependencies, loaded
  // lazily by the CLI — keep them out of the bundle so scan-only installs
  // stay lean.
  external: ['@repo-memory/api', '@repo-memory/mcp'],
});
