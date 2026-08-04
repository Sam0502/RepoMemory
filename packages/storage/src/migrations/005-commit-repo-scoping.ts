import type { Migration } from './runner.js';

const SQL = `
-- Scope commits by repo so two repos sharing a commit hash (vendored copies,
-- monorepo forks) don't clobber each other's commit + file_changes rows.

-- Ensure commits.repo_path exists (added by 002, kept defensive for partial installs)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'commits' AND column_name = 'repo_path'
  ) THEN
    ALTER TABLE commits ADD COLUMN repo_path VARCHAR(1000) NOT NULL DEFAULT '';
  END IF;
END $$;

-- Add repo_path to file_changes (nullable during backfill)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'file_changes' AND column_name = 'repo_path'
  ) THEN
    ALTER TABLE file_changes ADD COLUMN repo_path VARCHAR(1000);
  END IF;
END $$;

-- Backfill file_changes.repo_path from commits
UPDATE file_changes f
SET repo_path = c.repo_path
FROM commits c
WHERE c.hash = f.commit_hash;

-- Rebuild the PK + FK as composite (repo_path, hash)
ALTER TABLE file_changes DROP CONSTRAINT IF EXISTS file_changes_commit_hash_fkey;
ALTER TABLE commits DROP CONSTRAINT IF EXISTS commits_pkey;

ALTER TABLE commits ADD PRIMARY KEY (repo_path, hash);

ALTER TABLE file_changes ALTER COLUMN repo_path SET NOT NULL;
ALTER TABLE file_changes
  ADD CONSTRAINT file_changes_commit_hash_fkey
  FOREIGN KEY (repo_path, commit_hash) REFERENCES commits (repo_path, hash) ON DELETE CASCADE;

-- Replace the non-repo-scoped unique index on file_changes
DROP INDEX IF EXISTS idx_file_changes_unique;
CREATE UNIQUE INDEX IF NOT EXISTS idx_file_changes_unique ON file_changes (repo_path, commit_hash, file_path);

-- Hot-path indexes for commit/churn queries
CREATE INDEX IF NOT EXISTS idx_commits_repo_date ON commits (repo_path, date DESC);
CREATE INDEX IF NOT EXISTS idx_entities_repo_file ON entities (repo_path, file_path);
DROP INDEX IF EXISTS idx_file_changes_file;
CREATE INDEX IF NOT EXISTS idx_file_changes_path_commit ON file_changes (file_path, commit_hash);

-- Trigram index for ILIKE '%...%' entity search
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE INDEX IF NOT EXISTS idx_entities_name_trgm ON entities USING gin (name gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_entities_purpose_trgm ON entities USING gin (purpose gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_entities_responsibility_trgm ON entities USING gin (responsibility gin_trgm_ops);
`;

export const migration005: Migration = {
  id: 5,
  name: 'commit-repo-scoping',
  up: async (client) => {
    await client.query(SQL);
  },
};
