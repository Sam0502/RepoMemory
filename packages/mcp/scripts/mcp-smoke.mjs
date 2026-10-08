#!/usr/bin/env node
// Smoke test for the RepoMemory MCP server.
//
// Spawns the real stdio server (`node app/dist/cli.js mcp --repo <path>`) and
// drives it through the MCP SDK client, exercising the full tool surface.
//
// Usage:
//   node packages/mcp/scripts/mcp-smoke.mjs --repo /path/to/repo
//
// Requires the databases to be up (`pnpm db:up`) and the repo already scanned.

import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StdioClientTransport } = require('@modelcontextprotocol/sdk/client/stdio.js');

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const CLI_JS = join(REPO_ROOT, 'app', 'dist', 'cli.js');

const EXPECTED_TOOLS = [
  'entity_get',
  'entity_search',
  'entity_similar',
  'entity_dependencies',
  'entity_dependents',
  'entity_impact',
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
];

function arg(name, fallback) {
  const idx = process.argv.indexOf(name);
  if (idx === -1) return fallback;
  return process.argv[idx + 1];
}

function parseArgs() {
  const repo = arg('--repo', resolve('.'));
  const verbose = process.argv.includes('--verbose');
  return { repo, verbose };
}

// Compact result summary for the report table. Strips verbose fields and keeps
// the count-ish shape so a glance tells you the tool returned real data.
function summarize(data) {
  if (data == null) return { empty: true };
  const out = {};
  for (const key of ['count', 'error', 'entities', 'pack', 'churn', 'risk', 'repos', 'commits', 'answer', 'dead', 'boundaries', 'violations', 'ownership', 'drift', 'intent']) {
    if (Array.isArray(data[key])) out[key] = data[key].length;
    else if (data[key] !== undefined) out[key] = data[key];
  }
  if (data.entity) out.entity = data.entity.name;
  if (data.directImpact) out.directImpact = data.directImpact.length;
  if (data.indirectImpact) out.indirectImpact = data.indirectImpact.length;
  return Object.keys(out).length ? out : { keys: Object.keys(data).slice(0, 6) };
}

function firstText(result) {
  const text = result.content?.[0]?.text;
  return text ? JSON.parse(text) : {};
}

async function main() {
  const { repo, verbose } = parseArgs();

  console.log(`Spawn MCP server: node ${CLI_JS} mcp --repo ${repo}`);

  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [CLI_JS, 'mcp', '--repo', repo],
    cwd: REPO_ROOT,
    env: process.env,
    stderr: verbose ? 'inherit' : 'pipe',
  });

  const client = new Client({ name: 'mcp-smoke', version: '1.0.0' });

  const results = [];
  let failures = 0;

  try {
    await client.connect(transport);

    // 1. Tool listing
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name);
    const missing = EXPECTED_TOOLS.filter((t) => !names.includes(t));
    if (missing.length) {
      console.error(`Missing tools: ${missing.join(', ')}`);
      failures++;
    }
    results.push({ tool: '__list_tools__', status: missing.length ? 'error' : 'ok', ms: 0, detail: { listed: names.length, expected: EXPECTED_TOOLS.length } });

    const run = async (name, args, label) => {
      const start = Date.now();
      try {
        const result = await client.callTool({ name, arguments: args });
        const data = firstText(result);
        const ok = result.isError ? false : !data.error;
        if (!ok) failures++;
        results.push({
          tool: name,
          status: ok ? 'ok' : 'error',
          ms: Date.now() - start,
          detail: summarize(data),
          label,
        });
        return data;
      } catch (err) {
        failures++;
        results.push({ tool: name, status: 'error', ms: Date.now() - start, error: String(err) });
        return null;
      }
    };

    // 2. Workspace repos — focus on the served repo when it is scanned, else
    // the first scanned repo (repo-scoped tools run against the served repo,
    // so this only affects commits/task-context arguments).
    const repos = await run('workspace_repos', {}, 'list scanned repos');
    const scanned = (repos?.repos ?? []).map((r) => r.repoPath);
    const servedRepo = resolve(repo);
    const repoPath =
      scanned.find((p) => resolve(p).toLowerCase() === servedRepo.toLowerCase()) ||
      scanned[0] ||
      null;

    if (!repoPath) {
      console.error('No scanned repositories found. Scan a repo first:');
      console.error(`  node ${CLI_JS} scan --repo <path> --full`);
      process.exitCode = 1;
      return;
    }
    console.log(`\nServed repo: ${servedRepo}`);
    console.log(`Focus repo (for commits/task args): ${repoPath}\n`);

    // 3. Search → anchor entity
    const search = await run('entity_search', { query: 'createUser', limit: 10 }, 'search for createUser');
    const entities = search?.entities ?? [];
    const anchor = entities.find((e) => typeof e === 'object' && e.stableId) || null;

    if (anchor) {
      const id = anchor.stableId;
      const name = anchor.name || id;
      const scope = { stableId: id };

      await run('entity_get', scope, `get entity ${name}`);
      await run('entity_dependencies', scope, 'direct dependencies');
      await run('entity_dependencies', { stableId: id, depth: 3 }, 'transitive dependencies');
      await run('entity_dependents', scope, 'direct dependents');
      await run('entity_impact', scope, 'impact analysis');
      await run('entity_similar', scope, 'similar entities');
      await run('context_pack', { stableId: id, tokenBudget: 2000 }, 'entity context pack');
      await run('analysis_risk_entity', scope, 'entity change info');
      await run('qa_ask', { question: `what does ${name} depend on?` }, 'QA: dependencies');
    } else {
      console.warn('entity_search returned no anchors — skipping entity/graph tools');
    }

    // 4. Analysis reports
    await run('analysis_dead_code', { includeExported: true, batchSize: 1000 }, 'dead code report');
    await run('analysis_boundaries', { batchSize: 1000 }, 'boundary report');
    await run('analysis_churn', { limit: 10 }, 'top churned files');
    await run('analysis_risk', {}, 'repo risk');
    await run('analysis_drift', {}, 'architecture drift');
    await run('analysis_ownership', { limit: 10 }, 'file ownership');

    // 5. Commits
    const commits = await run('commits_recent', { limit: 5, repoPath }, 'recent commits');
    const hash = commits?.commits?.[0]?.hash;
    if (hash) {
      await run('commit_get', { hash }, `commit ${hash.slice(0, 8)}`);
    }

    // 6. Task context pack + workspace
    // Note: buildTaskContext's keyword search is whole-string ILIKE, so a
    // stable ID (direct-resolve path) is the reliable way to seed focal entities.
    const task = anchor ? anchor.stableId : 'createUser';
    await run('task_context', { task, tokenBudget: 1500, repoPath }, 'task context pack');
    await run('workspace_search', { query: 'TraversalService', limit: 5 }, 'workspace search');
    await run('workspace_qa', { question: 'which files have no tests?' }, 'workspace QA');

  } catch (err) {
    failures++;
    console.error(`\nFatal error:`, err);
  } finally {
    await client.close();
    await transport.close();
  }

  // 7. Report
  console.log(`\n${'='.repeat(72)}`);
  console.log('MCP smoke results');
  console.log(`${'='.repeat(72)}`);
  const pad = (s, n) => String(s).padEnd(n);
  console.log(`${pad('tool', 32)} ${pad('status', 7)} ${pad('ms', 8)} detail`);
  console.log('-'.repeat(72));
  for (const r of results) {
    const detail = r.error ? r.error : JSON.stringify(r.detail ?? {});
    console.log(`${pad(r.tool, 32)} ${pad(r.status, 7)} ${pad(r.ms, 8)} ${detail}`);
  }
  console.log('-'.repeat(72));
  console.log(`tools run: ${results.length}  ok: ${results.length - failures}  errors: ${failures}`);
  if (failures > 0) {
    console.error(`\nFAILED: ${failures} tool call(s) reported errors`);
    process.exitCode = 1;
  } else {
    console.log('\nAll tool calls succeeded.');
  }
}

main();
