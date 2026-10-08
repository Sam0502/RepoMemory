import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { readEntitySource } from '../src/source.js';

let dir: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'entity-source-'));
  writeFileSync(join(dir, 'a.ts'), 'line1\nline2\nline3\nline4\nline5\n');
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

function entity(overrides: Record<string, unknown> = {}) {
  return {
    stableId: 'abc',
    filePath: 'a.ts',
    startLine: 2,
    endLine: 4,
    ...overrides,
  };
}

describe('readEntitySource', () => {
  it('returns the exact line range', async () => {
    const source = await readEntitySource(dir, entity());
    expect(source).not.toBeNull();
    expect(source!.source).toBe('line2\nline3\nline4');
    expect(source!.totalLines).toBe(6);
    expect(source!.truncated).toBe(false);
    expect(source!.startLine).toBe(2);
    expect(source!.endLine).toBe(4);
  });

  it('caps long ranges at maxLines and flags truncation', async () => {
    const source = await readEntitySource(dir, entity({ startLine: 1, endLine: 5 }), 2);
    expect(source!.source).toBe('line1\nline2');
    expect(source!.truncated).toBe(true);
  });

  it('rejects paths escaping the repo root', async () => {
    await expect(readEntitySource(dir, entity({ filePath: '../evil.ts' }))).resolves.toBeNull();
    await expect(readEntitySource(dir, entity({ filePath: '/abs/evil.ts' }))).resolves.toBeNull();
    await expect(readEntitySource(dir, entity({ filePath: 'C:/evil.ts' }))).resolves.toBeNull();
  });

  it('returns null for missing files', async () => {
    await expect(readEntitySource(dir, entity({ filePath: 'nope.ts' }))).resolves.toBeNull();
  });
});
