import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { findStaleFiles } from '../src/integrity.js';

let dir: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'stale-files-'));
  writeFileSync(join(dir, 'kept.ts'), 'x\n');
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('findStaleFiles', () => {
  it('flags missing files and keeps existing ones', () => {
    expect(findStaleFiles(dir, ['kept.ts', 'gone.ts', 'sub/old.ts'])).toEqual(['gone.ts', 'sub/old.ts']);
  });

  it('dedupes and sorts', () => {
    expect(findStaleFiles(dir, ['b.ts', 'a.ts', 'b.ts'])).toEqual(['a.ts', 'b.ts']);
  });

  it('flags absolute and empty paths as stale', () => {
    expect(findStaleFiles(dir, ['', '/abs.ts', 'C:/win.ts'])).toEqual(['', '/abs.ts', 'C:/win.ts']);
  });

  it('treats a missing repo root as fully stale', () => {
    expect(findStaleFiles(join(dir, 'nope'), ['kept.ts'])).toEqual(['kept.ts']);
  });
});
