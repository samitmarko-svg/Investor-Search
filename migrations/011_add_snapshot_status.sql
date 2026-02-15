-- Migration 011: Add status tracking to snapshots
-- Supports async pipeline processing

ALTER TABLE snapshots ADD COLUMN IF NOT EXISTS status VARCHAR(20) DEFAULT 'PROCESSED'
  CHECK (status IN ('PROCESSING', 'PROCESSED', 'FAILED'));
ALTER TABLE snapshots ADD COLUMN IF NOT EXISTS processed_at TIMESTAMP WITH TIME ZONE;
ALTER TABLE snapshots ADD COLUMN IF NOT EXISTS error_message TEXT;
ALTER TABLE snapshots ADD COLUMN IF NOT EXISTS submitted_by_entity_id UUID;

CREATE INDEX IF NOT EXISTS idx_snapshots_status ON snapshots(status, created_at);

-- Add audit_log table
CREATE TABLE IF NOT EXISTS audit_log (
  id BIGSERIAL PRIMARY KEY,
  method VARCHAR(10) NOT NULL,
  path VARCHAR(500) NOT NULL,
  user_id UUID,
  entity_id UUID,
  ip_address VARCHAR(45),
  status_code INTEGER,
  request_body JSONB,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX idx_audit_log_created ON audit_log(created_at DESC);
CREATE INDEX idx_audit_log_user ON audit_log(user_id, created_at DESC);
