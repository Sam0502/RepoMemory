import { describe, it, expect } from 'vitest';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { createMcpServerFromServices } from '../src/mcp.js';
import type { McpServices } from '../src/services.js';

// Registration only closes over the services; handlers run lazily, so a sparse
// mock is enough to exercise listing + a single tool call end-to-end.
const services = {
  repoPath: '/repo',
  workspaceEntityRepo: {
    findByStableId: async (stableId: string) =>
      stableId === 'abc'
        ? { stableId: 'abc', filePath: 'src/a.ts', startLine: 1, endLine: 3, repoPath: '/repo' }
        : null,
  },
  entityRepo: { search: async () => [] },
  traversal: {
    findMembers: async () => [],
    countMembers: async () => 0,
  },
} as unknown as McpServices;

async function withConnectedServer<T>(run: (client: Client) => Promise<T>): Promise<T> {
  const server = createMcpServerFromServices(services);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: 'test', version: '1.0.0' });
  await client.connect(clientTransport);
  try {
    return await run(client);
  } finally {
    await client.close();
    await server.close();
  }
}

describe('MCP server', () => {
  it('exposes the read/analysis/workspace tool surface', async () => {
    await withConnectedServer(async (client) => {
      const { tools } = await client.listTools();
      const names = tools.map(t => t.name);
      for (const expected of [
        'entity_get',
        'entity_search',
        'entity_similar',
        'entity_dependencies',
        'entity_dependents',
        'entity_impact',
        'entity_members',
        'entity_source',
        'context_pack',
        'qa_ask',
        'task_context',
        'analysis_dead_code',
        'analysis_boundaries',
        'analysis_churn',
        'analysis_risk',
        'analysis_risk_entity',
        'analysis_drift',
        'analysis_ownership',
        'commits_recent',
        'commit_get',
        'workspace_repos',
        'workspace_search',
        'workspace_qa',
      ]) {
        expect(names).toContain(expected);
      }
    });
  });

  it('runs a tool call over the transport', async () => {
    await withConnectedServer(async (client) => {
      const result = await client.callTool({ name: 'entity_search', arguments: { query: 'user' } });
      expect(result.content).toHaveLength(1);
      expect(result.content[0]).toHaveProperty('text');
      expect(JSON.parse((result.content[0] as { text: string }).text)).toEqual({ entities: [], count: 0 });
    });
  });

  it('lists members of a known entity', async () => {
    await withConnectedServer(async (client) => {
      const result = await client.callTool({ name: 'entity_members', arguments: { stableId: 'abc' } });
      expect(JSON.parse((result.content[0] as { text: string }).text)).toEqual({
        stableId: 'abc',
        entities: [],
        count: 0,
        total: 0,
      });
    });
  });

  it('reports an error for unknown entities', async () => {
    await withConnectedServer(async (client) => {
      const members = await client.callTool({ name: 'entity_members', arguments: { stableId: 'nope' } });
      expect(JSON.parse((members.content[0] as { text: string }).text)).toEqual({
        error: 'Entity not found: nope',
      });
      const source = await client.callTool({ name: 'entity_source', arguments: { stableId: 'nope' } });
      expect(JSON.parse((source.content[0] as { text: string }).text)).toEqual({
        error: 'Entity not found: nope',
      });
    });
  });
});
