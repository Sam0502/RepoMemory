import type { Migration } from './runner.js';

const SQL = `
-- Increase relationship ID column sizes for existing installs (safe migration)
DO $$
BEGIN
  -- Increase source_id and target_id to VARCHAR(1000) if currently smaller
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'relationships' AND column_name = 'source_id'
    AND character_maximum_length < 1000
  ) THEN
    ALTER TABLE relationships ALTER COLUMN source_id TYPE VARCHAR(1000);
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'relationships' AND column_name = 'target_id'
    AND character_maximum_length < 1000
  ) THEN
    ALTER TABLE relationships ALTER COLUMN target_id TYPE VARCHAR(1000);
  END IF;
END $$;
`;

export const migration004: Migration = {
  id: 4,
  name: 'id-lengths',
  up: async (client) => {
    await client.query(SQL);
  },
};
