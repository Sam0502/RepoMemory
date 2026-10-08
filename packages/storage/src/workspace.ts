import { Pool } from 'pg';

export interface WorkspaceRepoStats {
  repoPath: string;
  entityCount: number;
  commitCount: number;
  lastCommitHash: string | null;
  lastScanAt: Date | null;
}

// Every scanned repository with entity/commit counts plus scan state.
// Shared by the CLI `workspace repos` command, the API workspace endpoint,
// and the MCP `workspace_repos` tool.
export async function listWorkspaceRepos(pool: Pool): Promise<WorkspaceRepoStats[]> {
  const result = await pool.query(
    `SELECT e.repo_path AS repo_path,
            COUNT(e.id)::int AS entity_count,
            (SELECT COUNT(*)::int FROM commits c WHERE c.repo_path = e.repo_path) AS commit_count
     FROM entities e
     WHERE e.repo_path <> ''
     GROUP BY e.repo_path
     ORDER BY e.repo_path`
  );
  const state = await pool.query('SELECT repo_path, last_commit_hash, last_scan_at FROM repo_state');
  const stateByPath = new Map<string, { last_commit_hash: string | null; last_scan_at: Date | null }>(
    state.rows.map((r) => [r.repo_path as string, r])
  );
  return result.rows.map((row) => ({
    repoPath: row.repo_path as string,
    entityCount: parseInt(row.entity_count, 10),
    commitCount: parseInt(row.commit_count, 10),
    lastCommitHash: stateByPath.get(row.repo_path)?.last_commit_hash ?? null,
    lastScanAt: stateByPath.get(row.repo_path)?.last_scan_at ?? null,
  }));
}
