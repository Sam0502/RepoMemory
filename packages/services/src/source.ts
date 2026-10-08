import { readFile } from 'node:fs/promises';
import { isAbsolute, relative, resolve } from 'node:path';
import type { Entity } from '@repo-memory/shared';

export const MAX_SOURCE_LINES = 2000;

export interface EntitySource {
  stableId: string;
  filePath: string;
  startLine: number;
  endLine: number;
  totalLines: number;
  truncated: boolean;
  source: string;
}

// Reads the exact source lines for an entity's [startLine, endLine] range
// from the working tree. Returns null when the path escapes the repo root
// (absolute paths, `..` segments, symlink-odd joins resolve outside) or the
// file cannot be read. Callers scope `repoRoot` to the entity's own repo so
// cross-repo lookups can never read outside their store.
export async function readEntitySource(
  repoRoot: string,
  entity: Pick<Entity, 'stableId' | 'filePath' | 'startLine' | 'endLine'>,
  maxLines: number = MAX_SOURCE_LINES
): Promise<EntitySource | null> {
  const normalized = (entity.filePath || '').replace(/\\/g, '/');
  if (!normalized || normalized.startsWith('/') || /^[A-Za-z]:/.test(normalized)) {
    return null;
  }
  const root = resolve(repoRoot);
  const full = resolve(root, normalized);
  const rel = relative(root, full);
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) {
    return null;
  }

  let content: string;
  try {
    content = await readFile(full, 'utf-8');
  } catch {
    return null;
  }

  const lines = content.split('\n');
  const start = Math.max(1, entity.startLine || 1);
  const end = Math.max(start, entity.endLine || start);
  const cap = Math.min(end, start + Math.max(1, maxLines) - 1);
  return {
    stableId: entity.stableId,
    filePath: entity.filePath,
    startLine: start,
    endLine: end,
    totalLines: lines.length,
    truncated: end > cap,
    source: lines.slice(start - 1, cap).join('\n'),
  };
}
