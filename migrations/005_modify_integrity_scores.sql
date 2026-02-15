-- Migration: 005_modify_integrity_scores
-- Description: Add relationship_id to integrity_scores table (nullable for backward compatibility)
-- Date: 2026-02-15

-- Add relationship_id column (nullable initially for backward compatibility)
ALTER TABLE integrity_scores
  ADD COLUMN IF NOT EXISTS relationship_id UUID REFERENCES relationships(id);

-- Index for relationship-scoped integrity queries
CREATE INDEX IF NOT EXISTS idx_integrity_scores_relationship
  ON integrity_scores(relationship_id);

-- Composite index for latest integrity score per relationship
CREATE INDEX IF NOT EXISTS idx_integrity_scores_relationship_date
  ON integrity_scores(relationship_id, calculated_at DESC);

-- Comment explaining the migration strategy
COMMENT ON COLUMN integrity_scores.relationship_id IS
  'Links integrity score to relationship. Nullable during migration period. '
  'Will be made NOT NULL after all existing scores are linked via migration script.';
