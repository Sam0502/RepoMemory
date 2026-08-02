import { Entity, EntityType } from '@repo-memory/shared';
import { createHash } from 'crypto';
import { getLanguageFromFilePath } from '../parser.js';

export function generateEntityStableId(repoPath: string, filePath: string, name: string): string {
  const input = `${repoPath}:${filePath}:${name}`;
  return createHash('md5').update(input).digest('hex');
}

export function generateFileStableId(repoPath: string, filePath: string): string {
  return createHash('md5').update(`file:${repoPath}:${filePath}`).digest('hex');
}

export function createFileEntity(filePath: string, repoPath: string = ''): Entity {
  const name = filePath.split('/').pop() || filePath.split('\\').pop() || filePath;
  const stableId = generateFileStableId(repoPath, filePath);
  return {
    id: stableId,
    stableId,
    name,
    type: EntityType.FILE,
    language: getLanguageFromFilePath(filePath),
    filePath,
    startLine: 1,
    endLine: 1,
    startColumn: 0,
    endColumn: 0,
    isExported: false,
    isTest: false,
    confidence: 1.0,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

function stripExtension(path: string): string {
  return path.replace(/\.(ts|tsx|js|jsx|mjs|cjs|py|pyw)$/, '');
}

function normalize(path: string): string {
  return path.replace(/\\/g, '/');
}

// Resolve an import specifier (relative path, package name, or bare module) to a known file path.
export function resolveImportPath(sourceFilePath: string, importPath: string, knownFiles: Set<string>): string | null {
  const normalizedSource = normalize(sourceFilePath);
  const sourceDir = normalizedSource.split('/').slice(0, -1).join('/');

  // Resolve relative paths (./foo, ../foo)
  if (importPath.startsWith('.')) {
    const stripped = stripExtension(importPath);
    const parts = (sourceDir + '/' + stripped).split('/');
    const resolved: string[] = [];
    for (const part of parts) {
      if (part === '..') resolved.pop();
      else if (part !== '.' && part !== '') resolved.push(part);
    }
    const base = resolved.join('/');
    const extensions = ['', '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.py', '.pyw', '/index.ts', '/index.tsx', '/index.js', '/index.jsx', '/index.py'];
    for (const ext of extensions) {
      const candidate = base + ext;
      if (knownFiles.has(candidate)) return candidate;
    }
    return null;
  }

  // Package / bare imports: resolve to a directory index or unique basename
  const lastSegment = importPath.split('/').pop() || importPath;
  const dirCandidates = [...knownFiles].filter(file => {
    const parts = normalize(file).split('/');
    return parts.slice(0, -1).includes(lastSegment);
  });
  if (dirCandidates.length > 0) {
    const indexFile = dirCandidates.find(file => /index\.(ts|tsx|js|jsx|py)$/.test(file));
    if (indexFile) return indexFile;
    return dirCandidates.length === 1 ? dirCandidates[0] : null;
  }

  const baseCandidates = [...knownFiles].filter(file => {
    const base = normalize(file).split('/').pop() || '';
    const strippedBase = stripExtension(base);
    return base === lastSegment || strippedBase === lastSegment;
  });
  if (baseCandidates.length === 1) return baseCandidates[0];

  return null;
}
