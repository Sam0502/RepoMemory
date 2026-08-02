import { describe, it, expect } from 'vitest';
import { mkdtemp, writeFile, unlink, rm, mkdir } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { FileWatcher } from '../src/file-watcher.js';
import type { FileChange } from '@repo-memory/shared';

function waitFor<T>(events: T[], predicate: (e: T) => boolean, timeoutMs = 8000): Promise<T> {
  return new Promise((resolve, reject) => {
    const check = () => {
      const found = events.find(predicate);
      if (found) {
        clearTimeout(timer);
        resolve(found);
      }
    };
    const timer = setTimeout(() => {
      clearInterval(interval);
      reject(new Error('Timed out waiting for event'));
    }, timeoutMs);
    const interval = setInterval(check, 25);
    check();
  });
}

function waitReady(watcher: FileWatcher, timeoutMs = 8000): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Timed out waiting for watcher ready')), timeoutMs);
    watcher.once('ready', () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

describe('FileWatcher', () => {
  it('emits add/change/delete events for source files', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'rmw-'));
    await mkdir(join(dir, 'src'), { recursive: true });

    const watcher = new FileWatcher(dir, { ignoreInitial: true });
    const adds: FileChange[] = [];
    const changes: FileChange[] = [];
    const deletes: FileChange[] = [];
    watcher.on('file:add', c => adds.push(c));
    watcher.on('file:change', c => changes.push(c));
    watcher.on('file:delete', c => deletes.push(c));

    try {
      const ready = waitReady(watcher);
      watcher.start();
      await ready;
      const filePath = join(dir, 'src', 'a.ts');
      await writeFile(filePath, 'export function a() {}\n', 'utf-8');
      const add = await waitFor(adds, c => c.filePath === 'src/a.ts');
      expect(add.status).toBe('added');
      expect(add.filePath).toBe('src/a.ts');

      await writeFile(filePath, 'export function a() { return 1; }\n', 'utf-8');
      const change = await waitFor(changes, c => c.filePath === 'src/a.ts');
      expect(change.status).toBe('modified');

      await unlink(filePath);
      const del = await waitFor(deletes, c => c.filePath === 'src/a.ts');
      expect(del.status).toBe('deleted');
    } finally {
      await watcher.stop();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('normalizes paths relative to the repo root', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'rmw-'));
    await mkdir(join(dir, 'lib'), { recursive: true });

    const watcher = new FileWatcher(dir, { ignoreInitial: true });
    const adds: FileChange[] = [];
    watcher.on('file:add', c => adds.push(c));

    try {
      const ready = waitReady(watcher);
      watcher.start();
      await ready;
      await writeFile(join(dir, 'lib', 'b.ts'), 'export const b = 1;\n', 'utf-8');
      const add = await waitFor(adds, c => c.filePath === 'lib/b.ts');
      expect(add.filePath).not.toContain(dir);
    } finally {
      await watcher.stop();
      await rm(dir, { recursive: true, force: true });
    }
  });
});
