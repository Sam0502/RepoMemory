import { describe, it, expect } from 'vitest';
import { GitOperations } from '../src/git.js';
import type { FileChange } from '@repo-memory/shared';

const git = new GitOperations('.') as unknown as {
  parseNumstatOutput(output: string): FileChange[];
};

describe('GitOperations.parseNumstatOutput', () => {
  it('parses simple add/delete numstat lines as modified', () => {
    const changes = git.parseNumstatOutput('5\t3\tsrc/a.ts\n');
    expect(changes).toHaveLength(1);
    expect(changes[0]).toMatchObject({
      filePath: 'src/a.ts',
      additions: 5,
      deletions: 3,
      status: 'modified',
    });
  });

  it('parses create/delete summary lines', () => {
    const changes = git.parseNumstatOutput(
      '0\t0\tsrc/new.ts\n0\t3\tsrc/old.ts\n create mode 100644 src/new.ts\n delete mode 100644 src/old.ts\n'
    );
    const byPath = new Map(changes.map(c => [c.filePath, c]));
    expect(byPath.get('src/new.ts')?.status).toBe('added');
    expect(byPath.get('src/old.ts')?.status).toBe('deleted');
  });

  it('parses rename summary lines', () => {
    const changes = git.parseNumstatOutput(
      '0\t0\tsrc/new.ts\n rename src/old.ts => src/new.ts (100%)\n'
    );
    const renamed = changes.find(c => c.filePath === 'src/new.ts');
    expect(renamed?.status).toBe('renamed');
    expect(renamed?.oldPath).toBe('src/old.ts');
  });

  it('handles inline rename in the numstat path', () => {
    const changes = git.parseNumstatOutput('3\t1\tsrc/old.ts => src/new.ts\n');
    expect(changes[0].filePath).toBe('src/new.ts');
    expect(changes[0].oldPath).toBe('src/old.ts');
    expect(changes[0].status).toBe('renamed');
  });

  it('treats binary files (-) as zero counts', () => {
    const changes = git.parseNumstatOutput('-\t-\tsrc/blob.bin\n');
    expect(changes[0].additions).toBe(0);
    expect(changes[0].deletions).toBe(0);
  });

  it('ignores empty and non-numstat lines', () => {
    expect(git.parseNumstatOutput('')).toEqual([]);
    expect(git.parseNumstatOutput('some random text\n')).toEqual([]);
  });
});
