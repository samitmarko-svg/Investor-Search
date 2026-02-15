-- Migration 009: Create relationship_events table
-- Stores all events for relationships with structured data

CREATE TABLE IF NOT EXISTS relationship_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  relationship_id UUID NOT NULL REFERENCES relationships(id) ON DELETE CASCADE,

  event_type VARCHAR(50) NOT NULL,
  event_category VARCHAR(20) NOT NULL CHECK (event_category IN ('LIFECYCLE', 'BEHAVIORAL', 'INTEGRITY', 'PATTERN')),
  event_data JSONB DEFAULT '{}',
  severity VARCHAR(20) NOT NULL DEFAULT 'INFO' CHECK (severity IN ('INFO', 'WARNING', 'CRITICAL')),

  occurred_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX idx_events_relationship ON relationship_events(relationship_id, occurred_at DESC);
CREATE INDEX idx_events_type ON relationship_events(event_type);
CREATE INDEX idx_events_severity ON relationship_events(severity, occurred_at DESC);
CREATE INDEX idx_events_category ON relationship_events(event_category, occurred_at DESC);
