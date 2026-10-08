import type { Migration } from './runner.js';

const SQL = `
-- Scope entity identity by repo so two repos with identical layouts can't
-- collide on stable_id. Stable IDs are already namespaced by repo path hash,
-- but the DB constraint must reflect the same contract.

-- Drop the legacy global unique on stable_id if present (name varies by PG version).
DO $$
DECLARE
  cname text;
BEGIN
  SELECT conname INTO cname
  FROM pg_constraint
  WHERE conrelid = 'entities'::regclass
    AND contype = 'u'
    AND array_length(conkey, 1) = 1
    AND (SELECT attname FROM pg_attribute WHERE attrelid = 'entities'::regclass AND attnum = conkey[1]) = 'stable_id'
  LIMIT 1;
  IF cname IS NOT NULL THEN
    EXECUTE format('ALTER TABLE entities DROP CONSTRAINT %I', cname);
  END IF;
END $$;

-- Ensure repo-scoped unique constraint exists (used by ON CONFLICT upsert).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'entities_repo_path_stable_id_key'
  ) THEN
    ALTER TABLE entities
      ADD CONSTRAINT entities_repo_path_stable_id_key
      UNIQUE (repo_path, stable_id);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_entities_repo_stable ON entities (repo_path, stable_id);
`;

export const migration006: Migration = {
  id: 6,
  name: 'entity-repo-scoping',
  up: async (client) => {
    await client.query(SQL);
  },
};
