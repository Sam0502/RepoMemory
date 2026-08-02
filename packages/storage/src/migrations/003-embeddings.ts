import type { Migration } from './runner.js';

const SQL = `
-- Add embedding column to existing entities table (safe for new installs)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'entities' AND column_name = 'embedding'
  ) THEN
    ALTER TABLE entities ADD COLUMN embedding vector(768);
  END IF;
END $$;

-- Embedding index (cosine similarity) - using hnsw for better performance
CREATE INDEX IF NOT EXISTS idx_entities_embedding ON entities USING hnsw (embedding vector_cosine_ops);
`;

export const migration003: Migration = {
  id: 3,
  name: 'embeddings',
  up: async (client) => {
    await client.query(SQL);
  },
};
