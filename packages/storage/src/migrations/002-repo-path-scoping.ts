import type { Migration } from './runner.js';

const SQL = `
-- Add repo_path column to entities for existing installs
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'entities' AND column_name = 'repo_path'
  ) THEN
    ALTER TABLE entities ADD COLUMN repo_path VARCHAR(1000) NOT NULL DEFAULT '';
  END IF;
END $$;

-- Add repo_path column to relationships for existing installs
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'relationships' AND column_name = 'repo_path'
  ) THEN
    ALTER TABLE relationships ADD COLUMN repo_path VARCHAR(1000) NOT NULL DEFAULT '';
  END IF;
END $$;

-- Add repo_path column to commits for existing installs
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'commits' AND column_name = 'repo_path'
  ) THEN
    ALTER TABLE commits ADD COLUMN repo_path VARCHAR(1000) NOT NULL DEFAULT '';
  END IF;
END $$;

-- Replace old non-repo-scoped unique constraint on relationships with repo-scoped one
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'relationships_source_id_target_id_type_file_path_key'
  ) THEN
    ALTER TABLE relationships DROP CONSTRAINT relationships_source_id_target_id_type_file_path_key;
  END IF;
END $$;

-- Ensure repo-scoped unique constraint exists (used by ON CONFLICT upsert)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'relationships_repo_path_source_id_target_id_type_file_path_key'
  ) THEN
    ALTER TABLE relationships
      ADD CONSTRAINT relationships_repo_path_source_id_target_id_type_file_path_key
      UNIQUE (repo_path, source_id, target_id, type, file_path);
  END IF;
END $$;

-- Repo-scoped indexes
CREATE INDEX IF NOT EXISTS idx_entities_repo_path ON entities(repo_path);
CREATE INDEX IF NOT EXISTS idx_relationships_repo_path ON relationships(repo_path);
`;

export const migration002: Migration = {
  id: 2,
  name: 'repo-path-scoping',
  up: async (client) => {
    await client.query(SQL);
  },
};
