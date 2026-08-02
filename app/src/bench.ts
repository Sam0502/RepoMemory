#!/usr/bin/env node

// Benchmark harness for analysis at repository scale (5.5).
//
// Usage:
//   pnpm bench --repo /path/to/repo            # analyze existing data
//   pnpm bench --repo /path/to/repo --full     # full scan first, then analyze
//   pnpm bench --repo /path/to/repo --batch 2000
//
// Prints timing + entity/relationship counts per analysis and peak RSS, so
// regressions in the streaming analysis paths (which must stay O(working-set))
// can be caught as repo size grows.

import { Orchestrator } from './orchestrator.js';
import { resolveBatchSize } from '@repo-memory/analysis';
import { resolve } from 'path';
import type { EmbeddingConfig } from '@repo-memory/analysis';

function parseArgs(argv: string[]): { repo: string; full: boolean; batchSize: number } {
  let repo = process.cwd();
  let full = false;
  let batchSize = resolveBatchSize();
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--repo' && argv[i + 1]) repo = argv[++i];
    else if (arg === '--full') full = true;
    else if (arg === '--batch' && argv[i + 1]) batchSize = parseInt(argv[++i], 10);
  }
  return { repo: resolve(repo), full, batchSize };
}

function getEmbeddingConfig(): EmbeddingConfig {
  const provider = process.env.EMBEDDING_PROVIDER || 'placeholder';
  return {
    provider: provider as EmbeddingConfig['provider'],
    onnx: {
      modelId: process.env.EMBEDDING_MODEL || 'Xenova/all-MiniLM-L6-v2',
      cacheDir: resolve(process.cwd(), 'models'),
    },
    gemini: process.env.GEMINI_API_KEY ? { apiKey: process.env.GEMINI_API_KEY, model: process.env.EMBEDDING_MODEL } : undefined,
  };
}

interface BenchRow {
  phase: string;
  durationMs: number;
  count: number;
  rssMb: number;
}

function rssMb(): number {
  return Math.round((process.memoryUsage().rss / 1024 / 1024) * 10) / 10;
}

async function main(): Promise<void> {
  const { repo, full, batchSize } = parseArgs(process.argv.slice(2));
  process.env.ANALYSIS_BATCH_SIZE = String(batchSize);

  const orchestrator = new Orchestrator({ repoPath: repo, embeddings: getEmbeddingConfig() });
  await orchestrator.initialize();

  const rows: BenchRow[] = [];

  try {
    if (full) {
      const report = await orchestrator.scanFullRepository();
      rows.push({
        phase: 'full-scan',
        durationMs: report.totalDurationMs,
        count: report.entitiesStored,
        rssMb: rssMb(),
      });
      console.log(
        `full-scan: ${report.totalDurationMs}ms | ${report.entitiesStored} entities, ${report.relationshipsStored} relationships | rss ${rssMb()}MB`
      );
    }

    const phases: Array<[string, () => Promise<{ count: number }>]> = [
      ['dead-code', async () => {
        const report = await orchestrator.getDeadCodeReport();
        return { count: report.totalEntities };
      }],
      ['boundaries', async () => {
        const report = await orchestrator.getBoundariesReport();
        return { count: report.crossDomainEdges.length };
      }],
      ['risk', async () => {
        const risk = await orchestrator.getFileRisk(100000);
        return { count: risk.length };
      }],
      ['drift', async () => {
        const drift = await orchestrator.getDrift();
        return { count: drift.signals.length };
      }],
    ];

    for (const [phase, run] of phases) {
      const before = rssMb();
      const t0 = performance.now();
      const { count } = await run();
      const durationMs = Math.round(performance.now() - t0);
      const after = rssMb();
      rows.push({ phase, durationMs, count, rssMb: after });
      console.log(
        `${phase.padEnd(12)} ${String(durationMs).padStart(6)}ms | count ${String(count).padStart(6)} | rss ${before}MB -> ${after}MB`
      );
    }
  } finally {
    await orchestrator.close();
  }

  console.log('---');
  console.log(`peak rss: ${Math.max(...rows.map(r => r.rssMb))}MB | batchSize: ${batchSize} | repo: ${repo}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
