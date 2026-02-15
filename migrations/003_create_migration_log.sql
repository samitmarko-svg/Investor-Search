-- Migration: 003_create_migration_log
-- Description: Create migration log table for tracking data migration from old schema
-- Date: 2026-02-15

CREATE TABLE IF NOT EXISTS migration_log (
  id SERIAL PRIMARY KEY,

  -- Migration tracking
  migration_name VARCHAR(255) NOT NULL,
  batch_id UUID DEFAULT gen_random_uuid(),

  -- Source and target references
  source_table VARCHAR(100),
  source_id UUID,
  target_table VARCHAR(100),
  target_id UUID,

  -- Migration details
  action VARCHAR(50) NOT NULL
    CHECK (action IN ('CREATED', 'LINKED', 'SKIPPED', 'FAILED', 'ROLLED_BACK')),
  details JSONB DEFAULT '{}',

  -- Status
  status VARCHAR(20) NOT NULL DEFAULT 'SUCCESS'
    CHECK (status IN ('SUCCESS', 'FAILED', 'ROLLED_BACK')),
  error_message TEXT,

  -- Timestamps
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Indexes
CREATE INDEX idx_migration_log_name ON migration_log(migration_name);
CREATE INDEX idx_migration_log_batch ON migration_log(batch_id);
CREATE INDEX idx_migration_log_status ON migration_log(status);
CREATE INDEX idx_migration_log_source ON migration_log(source_table, source_id);
CREATE INDEX idx_migration_log_created ON migration_log(created_at DESC);
