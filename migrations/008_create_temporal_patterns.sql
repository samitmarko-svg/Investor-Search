-- Migration 008: Create temporal_patterns table
-- Stores quantified temporal analysis results

CREATE TABLE IF NOT EXISTS temporal_patterns (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  relationship_id UUID NOT NULL REFERENCES relationships(id) ON DELETE CASCADE,
  snapshot_id UUID NOT NULL REFERENCES snapshots(id) ON DELETE CASCADE,

  -- Volatility (coefficient of variation)
  volatility_score FLOAT,
  volatility_classification VARCHAR(20) CHECK (volatility_classification IN ('STABLE', 'MODERATE', 'HIGH', 'EXTREME')),
  volatility_by_metric JSONB DEFAULT '{}',

  -- Recovery
  recovery_detected BOOLEAN DEFAULT FALSE,
  recovery_speed_days INTEGER,
  recovery_magnitude FLOAT,
  recovery_events JSONB DEFAULT '[]',

  -- Trajectory
  trajectory_direction VARCHAR(20) CHECK (trajectory_direction IN ('GROWTH', 'DECLINE', 'STABLE', 'VOLATILE')),
  trajectory_slope FLOAT,
  trajectory_r_squared FLOAT,

  -- Cadence
  cadence_mean_interval FLOAT,
  cadence_variance FLOAT,
  cadence_regularity VARCHAR(20) CHECK (cadence_regularity IN ('HIGH', 'MODERATE', 'LOW')),

  -- Metadata
  analyzed_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  analysis_version VARCHAR(10) DEFAULT '1.0',

  CONSTRAINT unique_pattern_per_snapshot UNIQUE (relationship_id, snapshot_id)
);

CREATE INDEX idx_temporal_patterns_relationship ON temporal_patterns(relationship_id, analyzed_at DESC);
CREATE INDEX idx_temporal_patterns_snapshot ON temporal_patterns(snapshot_id);
