import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

const r = (p: string) => fileURLToPath(new URL(p, import.meta.url));

export default defineConfig({
  test: {
    environment: 'node',
    include: ['packages/*/test/**/*.test.ts'],
    globals: false,
    testTimeout: 20000,
  },
  resolve: {
    alias: {
      '@repo-memory/shared': r('packages/shared/src/index.ts'),
      '@repo-memory/analysis': r('packages/analysis/src/index.ts'),
      '@repo-memory/api': r('packages/api/src/index.ts'),
      '@repo-memory/storage': r('packages/storage/src/index.ts'),
      '@repo-memory/graph': r('packages/graph/src/index.ts'),
      '@repo-memory/ingestion': r('packages/ingestion/src/index.ts'),
    },
  },
});
