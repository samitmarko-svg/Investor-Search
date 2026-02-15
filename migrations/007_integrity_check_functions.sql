-- Migration: 007_integrity_check_functions
-- Description: Create SQL functions for data integrity monitoring
-- Date: 2026-02-15

-- ============================================
-- Check 1: Snapshot-Relationship Integrity
-- Ensures all snapshots are linked to valid relationships
-- ============================================
CREATE OR REPLACE FUNCTION check_snapshot_relationship_integrity()
RETURNS TABLE (
  total_snapshots BIGINT,
  linked_snapshots BIGINT,
  orphan_count BIGINT,
  integrity_percentage NUMERIC
) AS $$
BEGIN
  RETURN QUERY
  SELECT
    COUNT(*)::BIGINT as total_snapshots,
    COUNT(s.relationship_id)::BIGINT as linked_snapshots,
    (COUNT(*) - COUNT(s.relationship_id))::BIGINT as orphan_count,
    CASE
      WHEN COUNT(*) = 0 THEN 100.0
      ELSE ROUND((COUNT(s.relationship_id)::NUMERIC / COUNT(*)::NUMERIC) * 100, 2)
    END as integrity_percentage
  FROM snapshots s;
END;
$$ LANGUAGE plpgsql;

-- ============================================
-- Check 2: Relationship Entity Validity
-- Ensures all relationship entity references are valid
-- ============================================
CREATE OR REPLACE FUNCTION check_relationship_entity_validity()
RETURNS TABLE (
  total_relationships BIGINT,
  invalid_count BIGINT,
  invalid_entity_a_ids UUID[],
  invalid_entity_b_ids UUID[]
) AS $$
BEGIN
  RETURN QUERY
  SELECT
    (SELECT COUNT(*)::BIGINT FROM relationships WHERE deleted_at IS NULL) as total_relationships,
    (
      SELECT COUNT(*)::BIGINT
      FROM relationships r
      WHERE r.deleted_at IS NULL
        AND (
          NOT EXISTS (SELECT 1 FROM entities e WHERE e.id = r.entity_a_id)
          OR NOT EXISTS (SELECT 1 FROM entities e WHERE e.id = r.entity_b_id)
        )
    ) as invalid_count,
    (
      SELECT ARRAY_AGG(DISTINCT r.entity_a_id)
      FROM relationships r
      WHERE r.deleted_at IS NULL
        AND NOT EXISTS (SELECT 1 FROM entities e WHERE e.id = r.entity_a_id)
    ) as invalid_entity_a_ids,
    (
      SELECT ARRAY_AGG(DISTINCT r.entity_b_id)
      FROM relationships r
      WHERE r.deleted_at IS NULL
        AND NOT EXISTS (SELECT 1 FROM entities e WHERE e.id = r.entity_b_id)
    ) as invalid_entity_b_ids;
END;
$$ LANGUAGE plpgsql;

-- ============================================
-- Check 3: Alignment Consistency
-- Ensures alignment data is consistent
-- ============================================
CREATE OR REPLACE FUNCTION check_alignment_consistency()
RETURNS TABLE (
  relationships_without_alignment BIGINT,
  relationships_with_multiple_active_alignments BIGINT
) AS $$
BEGIN
  RETURN QUERY
  SELECT
    (SELECT COUNT(*)::BIGINT
     FROM relationships r
     WHERE r.status = 'ACTIVE'
       AND r.deleted_at IS NULL
       AND NOT EXISTS (
         SELECT 1 FROM relationship_alignments ra
         WHERE ra.relationship_id = r.id AND ra.status = 'ACTIVE'
       )
    ) as relationships_without_alignment,
    (SELECT COUNT(*)::BIGINT
     FROM (
       SELECT relationship_id, COUNT(*) as active_count
       FROM relationship_alignments
       WHERE status = 'ACTIVE'
       GROUP BY relationship_id
       HAVING COUNT(*) > 1
     ) duplicates
    ) as relationships_with_multiple_active_alignments;
END;
$$ LANGUAGE plpgsql;

-- ============================================
-- Daily Integrity Check Runner
-- Aggregates all checks into a single JSONB result
-- ============================================
CREATE OR REPLACE FUNCTION run_daily_integrity_checks()
RETURNS JSONB AS $$
DECLARE
  result JSONB;
  snapshot_check RECORD;
  entity_check RECORD;
  alignment_check RECORD;
BEGIN
  SELECT * INTO snapshot_check FROM check_snapshot_relationship_integrity();
  SELECT * INTO entity_check FROM check_relationship_entity_validity();
  SELECT * INTO alignment_check FROM check_alignment_consistency();

  result := jsonb_build_object(
    'timestamp', NOW(),
    'snapshot_integrity', jsonb_build_object(
      'orphan_count', snapshot_check.orphan_count,
      'total_snapshots', snapshot_check.total_snapshots,
      'integrity_percentage', snapshot_check.integrity_percentage,
      'status', CASE
        WHEN snapshot_check.orphan_count = 0 THEN 'PASS'
        WHEN snapshot_check.orphan_count < 10 THEN 'WARNING'
        ELSE 'FAIL'
      END
    ),
    'entity_validity', jsonb_build_object(
      'invalid_count', entity_check.invalid_count,
      'status', CASE
        WHEN entity_check.invalid_count = 0 THEN 'PASS'
        ELSE 'FAIL'
      END
    ),
    'alignment_consistency', jsonb_build_object(
      'missing_alignments', alignment_check.relationships_without_alignment,
      'duplicate_alignments', alignment_check.relationships_with_multiple_active_alignments,
      'status', CASE
        WHEN alignment_check.relationships_without_alignment = 0
         AND alignment_check.relationships_with_multiple_active_alignments = 0
        THEN 'PASS'
        ELSE 'FAIL'
      END
    )
  );

  INSERT INTO integrity_check_log (check_date, results)
  VALUES (NOW(), result);

  IF result->'snapshot_integrity'->>'status' = 'FAIL'
     OR result->'entity_validity'->>'status' = 'FAIL'
     OR result->'alignment_consistency'->>'status' = 'FAIL' THEN
    PERFORM pg_notify('integrity_check_failed', result::text);
  END IF;

  RETURN result;
END;
$$ LANGUAGE plpgsql;
