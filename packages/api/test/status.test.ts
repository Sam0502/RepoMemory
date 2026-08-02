import { describe, it, expect } from 'vitest';
import { createApp } from '../src/server.js';
import type { RepoStatus } from '@repo-memory/shared';

// The /api/status endpoint only consults the optional `getStatus` provider, so a
// fully mock config is enough to exercise it (no pool/graph queries run).
function makeApp(getStatus?: () => Promise<RepoStatus>) {
  return createApp({
    port: 0,
    host: 'localhost',
    repoPath: '/repo',
    graphClient: {} as never,
    pgPool: {} as never,
    getStatus,
  });
}

describe('GET /api/status', () => {
  it('reports the repo as not watched when no provider is wired', async () => {
    const app = makeApp();
    const res = await app.request('/api/status');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({
      repoPath: '/repo',
      watching: false,
      lastScanAt: null,
      pendingChanges: 0,
    });
  });

  it('returns the provider status when wired', async () => {
    const status: RepoStatus = {
      repoPath: '/repo',
      watching: true,
      lastScanAt: '2026-08-02T00:00:00.000Z',
      pendingChanges: 3,
    };
    const app = makeApp(async () => status);
    const res = await app.request('/api/status');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(status);
  });
});
