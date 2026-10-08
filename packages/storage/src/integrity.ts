import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';

// Distinct file paths (as stored, forward-slash relative) that no longer
// exist under the repo root. A missing repo root counts everything as stale:
// data for a deleted repository is garbage by definition. Sorted for stable
// reports.
export function findStaleFiles(repoPath: string, filePaths: string[]): string[] {
  const root = resolve(repoPath);
  const stale: string[] = [];
  for (const filePath of new Set(filePaths)) {
    const normalized = (filePath || '').replace(/\\/g, '/');
    if (!normalized || normalized.startsWith('/') || /^[A-Za-z]:/.test(normalized)) {
      stale.push(filePath);
      continue;
    }
    if (!existsSync(join(root, normalized))) {
      stale.push(filePath);
    }
  }
  return stale.sort();
}
