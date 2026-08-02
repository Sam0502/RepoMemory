import { describe, it, expect } from 'vitest';
import {
  generateEntityStableId,
  generateFileStableId,
  createFileEntity,
  resolveImportPath,
} from '../src/resolver/ids.js';

describe('generateEntityStableId', () => {
  it('is deterministic for the same inputs', () => {
    expect(generateEntityStableId('/repo', 'src/a.ts', 'foo')).toBe(
      generateEntityStableId('/repo', 'src/a.ts', 'foo')
    );
  });

  it('differs across repos, files, and names', () => {
    const a = generateEntityStableId('/repo', 'src/a.ts', 'foo');
    const b = generateEntityStableId('/repo2', 'src/a.ts', 'foo');
    const c = generateEntityStableId('/repo', 'src/b.ts', 'foo');
    const d = generateEntityStableId('/repo', 'src/a.ts', 'bar');
    expect(new Set([a, b, c, d]).size).toBe(4);
  });
});

describe('generateFileStableId', () => {
  it('namespaces by repo path', () => {
    expect(generateFileStableId('/repo', 'src/a.ts')).not.toBe(
      generateFileStableId('/repo2', 'src/a.ts')
    );
  });
});

describe('createFileEntity', () => {
  it('creates a File entity with a derived name', () => {
    const entity = createFileEntity('src/routes.ts', '/repo');
    expect(entity.type).toBe('File');
    expect(entity.name).toBe('routes.ts');
    expect(entity.filePath).toBe('src/routes.ts');
    expect(entity.stableId).toBe(generateFileStableId('/repo', 'src/routes.ts'));
  });
});

describe('resolveImportPath', () => {
  const files = new Set([
    'src/utils.ts',
    'src/api/users.ts',
    'src/api/index.ts',
    'src/index.ts',
    'other/helpers.ts',
  ]);

  it('resolves a relative path with extension', () => {
    expect(resolveImportPath('src/routes.ts', './utils', files)).toBe('src/utils.ts');
    expect(resolveImportPath('src/routes.ts', './api/users.ts', files)).toBe('src/api/users.ts');
  });

  it('resolves a relative path with directory index', () => {
    expect(resolveImportPath('src/routes.ts', './api', files)).toBe('src/api/index.ts');
  });

  it('resolves package-name to a unique basename', () => {
    expect(resolveImportPath('src/routes.ts', 'helpers', files)).toBe('other/helpers.ts');
  });

  it('resolves package-name to a directory index', () => {
    expect(resolveImportPath('src/routes.ts', 'api', files)).toBe('src/api/index.ts');
  });

  it('returns null for an unknown module', () => {
    expect(resolveImportPath('src/routes.ts', 'nope', files)).toBeNull();
  });

  it('handles parent-directory traversal', () => {
    const set = new Set(['src/shared/format.ts']);
    expect(resolveImportPath('src/deep/nested/file.ts', '../../shared/format', set)).toBe(
      'src/shared/format.ts'
    );
  });
});
