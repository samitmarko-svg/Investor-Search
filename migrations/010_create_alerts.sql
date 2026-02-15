-- Migration 010: Create alerts table
-- Stores alerts generated from events

CREATE TABLE IF NOT EXISTS alerts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  relationship_id UUID NOT NULL REFERENCES relationships(id) ON DELETE CASCADE,
  event_id UUID REFERENCES relationship_events(id) ON DELETE SET NULL,

  alert_type VARCHAR(50) NOT NULL,
  severity VARCHAR(20) NOT NULL DEFAULT 'INFO' CHECK (severity IN ('INFO', 'WARNING', 'CRITICAL')),
  title VARCHAR(255) NOT NULL,
  description TEXT,
  visibility VARCHAR(20) DEFAULT 'BOTH_PARTIES' CHECK (visibility IN ('BOTH_PARTIES', 'FOUNDER_ONLY', 'INVESTOR_ONLY')),
  status VARCHAR(20) DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'ACKNOWLEDGED', 'RESOLVED')),

  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  acknowledged_at TIMESTAMP WITH TIME ZONE,
  resolved_at TIMESTAMP WITH TIME ZONE
);

CREATE INDEX idx_alerts_relationship ON alerts(relationship_id, created_at DESC);
CREATE INDEX idx_alerts_status ON alerts(status, severity);
