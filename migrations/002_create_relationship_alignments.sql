-- Migration: 002_create_relationship_alignments
-- Description: Create relationship alignments table for tracking alignment state
-- Date: 2026-02-15

CREATE TABLE IF NOT EXISTS relationship_alignments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Link to relationship
  relationship_id UUID NOT NULL REFERENCES relationships(id) ON DELETE CASCADE,

  -- Alignment data
  alignment_type VARCHAR(50) NOT NULL,
  alignment_data JSONB NOT NULL DEFAULT '{}',

  -- Status
  status VARCHAR(20) NOT NULL DEFAULT 'ACTIVE'
    CHECK (status IN ('ACTIVE', 'EXPIRED', 'SUPERSEDED')),

  -- Validity period
  valid_from TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  valid_until TIMESTAMP WITH TIME ZONE,

  -- Timestamps
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),

  -- Metadata
  created_by UUID,
  notes TEXT
);

-- Indexes
CREATE INDEX idx_alignments_relationship ON relationship_alignments(relationship_id);
CREATE INDEX idx_alignments_status ON relationship_alignments(status);
CREATE INDEX idx_alignments_type ON relationship_alignments(alignment_type);
CREATE INDEX idx_alignments_valid_from ON relationship_alignments(valid_from DESC);

-- Composite index for active alignments per relationship
CREATE INDEX idx_alignments_active
  ON relationship_alignments(relationship_id, status)
  WHERE status = 'ACTIVE';

-- Updated_at trigger
CREATE OR REPLACE FUNCTION update_alignments_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trigger_alignments_updated_at
  BEFORE UPDATE ON relationship_alignments
  FOR EACH ROW
  EXECUTE FUNCTION update_alignments_updated_at();
