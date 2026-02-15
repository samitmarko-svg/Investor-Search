-- Migration: 004_modify_snapshots
-- Description: Add relationship_id to snapshots table (nullable for backward compatibility)
-- Date: 2026-02-15

-- Add relationship_id column (nullable initially for backward compatibility)
ALTER TABLE snapshots
  ADD COLUMN IF NOT EXISTS relationship_id UUID REFERENCES relationships(id);

-- Index for relationship-scoped snapshot queries
CREATE INDEX IF NOT EXISTS idx_snapshots_relationship
  ON snapshots(relationship_id);

-- Composite index for relationship + date queries
CREATE INDEX IF NOT EXISTS idx_snapshots_relationship_date
  ON snapshots(relationship_id, snapshot_date DESC);

-- Comment explaining the migration strategy
COMMENT ON COLUMN snapshots.relationship_id IS
  'Links snapshot to relationship. Nullable during migration period. '
  'Will be made NOT NULL after all existing snapshots are linked via migration script.';
