import { Pool } from 'pg';

const SCHEMA_SQL = `
-- Enable UUID extension
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- Entities table
CREATE TABLE IF NOT EXISTS entities (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  stable_id VARCHAR(255) NOT NULL UNIQUE,
  name VARCHAR(500) NOT NULL,
  type VARCHAR(50) NOT NULL,
  language VARCHAR(50) NOT NULL,
  file_path VARCHAR(1000) NOT NULL,
  start_line INTEGER NOT NULL,
  end_line INTEGER NOT NULL,
  start_column INTEGER NOT NULL,
  end_column INTEGER NOT NULL,
  signature TEXT,
  docstring TEXT,
  purpose TEXT,
  responsibility TEXT,
  domain VARCHAR(255),
  architectural_role VARCHAR(255),
  is_exported BOOLEAN DEFAULT FALSE,
  is_test BOOLEAN DEFAULT FALSE,
  confidence FLOAT DEFAULT 1.0,
  first_seen_commit VARCHAR(40),
  last_seen_commit VARCHAR(40),
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Relationships table
CREATE TABLE IF NOT EXISTS relationships (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  source_id VARCHAR(255) NOT NULL,
  target_id VARCHAR(255) NOT NULL,
  type VARCHAR(50) NOT NULL,
  file_path VARCHAR(1000) NOT NULL,
  line INTEGER,
  confidence FLOAT DEFAULT 1.0,
  metadata JSONB,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  UNIQUE(source_id, target_id, type, file_path)
);

-- Commits table
CREATE TABLE IF NOT EXISTS commits (
  hash VARCHAR(40) PRIMARY KEY,
  message TEXT NOT NULL,
  author VARCHAR(255) NOT NULL,
  date TIMESTAMP WITH TIME ZONE NOT NULL,
  files_changed JSONB DEFAULT '[]'::JSONB,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- File changes table
CREATE TABLE IF NOT EXISTS file_changes (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  commit_hash VARCHAR(40) NOT NULL REFERENCES commits(hash) ON DELETE CASCADE,
  file_path VARCHAR(1000) NOT NULL,
  additions INTEGER DEFAULT 0,
  deletions INTEGER DEFAULT 0,
  status VARCHAR(20) NOT NULL,
  old_path VARCHAR(1000),
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Jobs table for tracking ingestion jobs
CREATE TABLE IF NOT EXISTS jobs (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  type VARCHAR(50) NOT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'pending',
  repository_path VARCHAR(1000) NOT NULL,
  commit_hash VARCHAR(40),
  files_to_process JSONB DEFAULT '[]'::JSONB,
  result JSONB,
  error TEXT,
  started_at TIMESTAMP WITH TIME ZONE,
  completed_at TIMESTAMP WITH TIME ZONE,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_entities_stable_id ON entities(stable_id);
CREATE INDEX IF NOT EXISTS idx_entities_type ON entities(type);
CREATE INDEX IF NOT EXISTS idx_entities_language ON entities(language);
CREATE INDEX IF NOT EXISTS idx_entities_file_path ON entities(file_path);
CREATE INDEX IF NOT EXISTS idx_relationships_source ON relationships(source_id);
CREATE INDEX IF NOT EXISTS idx_relationships_target ON relationships(target_id);
CREATE INDEX IF NOT EXISTS idx_relationships_type ON relationships(type);
CREATE INDEX IF NOT EXISTS idx_file_changes_commit ON file_changes(commit_hash);
CREATE INDEX IF NOT EXISTS idx_jobs_status ON jobs(status);
CREATE INDEX IF NOT EXISTS idx_jobs_type ON jobs(type);
`;

export async function migrate(pool: Pool): Promise<void> {
  console.log('Running database migration...');
  await pool.query(SCHEMA_SQL);
  console.log('Database migration completed.');
}

export async function createPool(config: {
  host: string;
  port: number;
  database: string;
  user: string;
  password: string;
}): Promise<Pool> {
  const pool = new Pool(config);
  
  // Test connection
  try {
    await pool.query('SELECT 1');
    console.log('Database connection successful.');
  } catch (error) {
    console.error('Database connection failed:', error);
    throw error;
  }
  
  return pool;
}
