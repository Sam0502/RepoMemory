import type { Migration } from './runner.js';

const SQL = `
-- Track which embedding provider produced the stored vectors so a provider
-- switch triggers a re-embed instead of mixing incomparable vector spaces.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'repo_state' AND column_name = 'embedding_provider'
  ) THEN
    ALTER TABLE repo_state ADD COLUMN embedding_provider VARCHAR(100);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'repo_state' AND column_name = 'embedding_model'
  ) THEN
    ALTER TABLE repo_state ADD COLUMN embedding_model VARCHAR(200);
  END IF;
END $$;
`;

export const migration007: Migration = {
  id: 7,
  name: 'embedding-provider-tracking',
  up: async (client) => {
    await client.query(SQL);
  },
};
