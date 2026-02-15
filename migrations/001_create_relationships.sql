-- Migration: 001_create_relationships
-- Description: Create the core relationships table
-- Date: 2026-02-15

CREATE TABLE IF NOT EXISTS relationships (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Entities in this relationship
  entity_a_id UUID NOT NULL REFERENCES entities(id),
  entity_b_id UUID NOT NULL REFERENCES entities(id),

  -- Roles within the relationship
  role_a VARCHAR(50) NOT NULL,
  role_b VARCHAR(50) NOT NULL,

  -- Relationship classification
  relationship_type VARCHAR(50) NOT NULL DEFAULT 'INVESTMENT',

  -- Status tracking
  status VARCHAR(20) NOT NULL DEFAULT 'PENDING'
    CHECK (status IN ('PENDING', 'ACTIVE', 'PAUSED', 'TERMINATED')),

  -- Timestamps
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  activated_at TIMESTAMP WITH TIME ZONE,
  terminated_at TIMESTAMP WITH TIME ZONE,
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  deleted_at TIMESTAMP WITH TIME ZONE,

  -- Metadata
  created_by UUID,
  metadata JSONB DEFAULT '{}',

  -- Constraints
  CONSTRAINT different_entities CHECK (entity_a_id != entity_b_id),
  CONSTRAINT valid_relationship_type CHECK (
    relationship_type IN ('INVESTMENT', 'PARTNERSHIP', 'DISTRIBUTION', 'ADVISORY', 'VENDOR')
  )
);

-- Indexes
CREATE INDEX idx_relationships_entity_a ON relationships(entity_a_id);
CREATE INDEX idx_relationships_entity_b ON relationships(entity_b_id);
CREATE INDEX idx_relationships_type ON relationships(relationship_type);
CREATE INDEX idx_relationships_status ON relationships(status);
CREATE INDEX idx_relationships_created ON relationships(created_at DESC);

-- Composite index for finding all relationships for an entity
CREATE INDEX idx_relationships_entities ON relationships(entity_a_id, entity_b_id);

-- Unique constraint: no duplicate active relationships between same entities with same type
CREATE UNIQUE INDEX idx_unique_active_relationship
  ON relationships(entity_a_id, entity_b_id, relationship_type)
  WHERE deleted_at IS NULL AND status != 'TERMINATED';

-- Updated_at trigger
CREATE OR REPLACE FUNCTION update_relationships_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trigger_relationships_updated_at
  BEFORE UPDATE ON relationships
  FOR EACH ROW
  EXECUTE FUNCTION update_relationships_updated_at();
