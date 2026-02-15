-- Migration: 006_create_integrity_check_log
-- Description: Create log table for automated integrity checks
-- Date: 2026-02-15

CREATE TABLE IF NOT EXISTS integrity_check_log (
  id SERIAL PRIMARY KEY,
  check_date TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  results JSONB NOT NULL
);

CREATE INDEX idx_integrity_check_date ON integrity_check_log(check_date DESC);
