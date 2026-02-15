/**
 * Monitoring & Alerting
 *
 * Real-time monitoring metrics, alert thresholds, and rollback criteria.
 */

import { Pool } from 'pg';

export interface MonitoringMetrics {
  api_error_rate: number;
  api_response_time_p95: number;
  snapshot_relationship_integrity: number;
  orphaned_snapshots: number;
  orphaned_integrity_scores: number;
  relationships_without_alignment: number;
  total_relationships: number;
  relationships_by_type: Record<string, number>;
  active_relationships: number;
  snapshots_submitted_today: number;
  new_relationships_today: number;
}

export interface Alert {
  severity: 'INFO' | 'WARNING' | 'CRITICAL';
  message: string;
  metric: string;
  value: number;
  threshold: number;
}

export interface RollbackCriteria {
  api_error_rate_threshold: number;
  data_integrity_threshold: number;
  critical_function_failure: boolean;
}

// Alert thresholds
export const ALERT_THRESHOLDS = {
  api_error_rate: 5,
  api_response_time_p95: 500,
  snapshot_relationship_integrity: 99,
  orphaned_snapshots: 10,
  relationships_without_alignment: 5,
} as const;

// Rollback criteria
export const ROLLBACK_CRITERIA: RollbackCriteria = {
  api_error_rate_threshold: 10,
  data_integrity_threshold: 95,
  critical_function_failure: true,
};

/**
 * Collect all monitoring metrics from the database.
 */
export async function collectMetrics(db: Pool): Promise<MonitoringMetrics> {
  const [
    snapshotIntegrity,
    orphanedScores,
    missingAlignments,
    relationshipStats,
    todayStats,
  ] = await Promise.all([
    checkSnapshotIntegrity(db),
    countOrphanedIntegrityScores(db),
    countMissingAlignments(db),
    getRelationshipStats(db),
    getTodayStats(db),
  ]);

  return {
    api_error_rate: 0, // Set by application-level metrics
    api_response_time_p95: 0, // Set by application-level metrics
    snapshot_relationship_integrity: snapshotIntegrity.integrity_percentage,
    orphaned_snapshots: snapshotIntegrity.orphan_count,
    orphaned_integrity_scores: orphanedScores,
    relationships_without_alignment: missingAlignments,
    total_relationships: relationshipStats.total,
    relationships_by_type: relationshipStats.by_type,
    active_relationships: relationshipStats.active,
    snapshots_submitted_today: todayStats.snapshots,
    new_relationships_today: todayStats.relationships,
  };
}

/**
 * Check metrics against alert thresholds.
 */
export function checkAlerts(metrics: MonitoringMetrics): Alert[] {
  const alerts: Alert[] = [];

  if (metrics.api_error_rate > ALERT_THRESHOLDS.api_error_rate) {
    alerts.push({
      severity: 'CRITICAL',
      message: `API error rate ${metrics.api_error_rate}% exceeds threshold`,
      metric: 'api_error_rate',
      value: metrics.api_error_rate,
      threshold: ALERT_THRESHOLDS.api_error_rate,
    });
  }

  if (metrics.snapshot_relationship_integrity < ALERT_THRESHOLDS.snapshot_relationship_integrity) {
    alerts.push({
      severity: 'WARNING',
      message: `Snapshot integrity ${metrics.snapshot_relationship_integrity}% below threshold`,
      metric: 'snapshot_relationship_integrity',
      value: metrics.snapshot_relationship_integrity,
      threshold: ALERT_THRESHOLDS.snapshot_relationship_integrity,
    });
  }

  if (metrics.orphaned_snapshots > ALERT_THRESHOLDS.orphaned_snapshots) {
    alerts.push({
      severity: 'WARNING',
      message: `${metrics.orphaned_snapshots} orphaned snapshots detected`,
      metric: 'orphaned_snapshots',
      value: metrics.orphaned_snapshots,
      threshold: ALERT_THRESHOLDS.orphaned_snapshots,
    });
  }

  if (metrics.relationships_without_alignment > ALERT_THRESHOLDS.relationships_without_alignment) {
    alerts.push({
      severity: 'WARNING',
      message: `${metrics.relationships_without_alignment} active relationships missing alignment`,
      metric: 'relationships_without_alignment',
      value: metrics.relationships_without_alignment,
      threshold: ALERT_THRESHOLDS.relationships_without_alignment,
    });
  }

  return alerts;
}

/**
 * Determine if automated rollback should be triggered.
 */
export function shouldRollback(metrics: MonitoringMetrics): boolean {
  if (metrics.api_error_rate > ROLLBACK_CRITERIA.api_error_rate_threshold) {
    return true;
  }

  if (metrics.snapshot_relationship_integrity < ROLLBACK_CRITERIA.data_integrity_threshold) {
    return true;
  }

  return false;
}

// ============================================
// Database query helpers
// ============================================

async function checkSnapshotIntegrity(db: Pool): Promise<{
  integrity_percentage: number;
  orphan_count: number;
}> {
  const result = await db.query('SELECT * FROM check_snapshot_relationship_integrity()');
  const row = result.rows[0];
  return {
    integrity_percentage: parseFloat(row.integrity_percentage) || 100,
    orphan_count: parseInt(row.orphan_count, 10) || 0,
  };
}

async function countOrphanedIntegrityScores(db: Pool): Promise<number> {
  const result = await db.query(`
    SELECT COUNT(*) as count
    FROM integrity_scores i
    WHERE i.relationship_id IS NULL
      OR NOT EXISTS (
        SELECT 1 FROM relationships r
        WHERE r.id = i.relationship_id AND r.deleted_at IS NULL
      )
  `);
  return parseInt(result.rows[0].count, 10);
}

async function countMissingAlignments(db: Pool): Promise<number> {
  const result = await db.query(`
    SELECT COUNT(*) as count
    FROM relationships r
    WHERE r.status = 'ACTIVE'
      AND r.deleted_at IS NULL
      AND NOT EXISTS (
        SELECT 1 FROM relationship_alignments ra
        WHERE ra.relationship_id = r.id AND ra.status = 'ACTIVE'
      )
  `);
  return parseInt(result.rows[0].count, 10);
}

async function getRelationshipStats(db: Pool): Promise<{
  total: number;
  active: number;
  by_type: Record<string, number>;
}> {
  const result = await db.query(`
    SELECT
      COUNT(*) as total,
      COUNT(*) FILTER (WHERE status = 'ACTIVE') as active,
      relationship_type,
      COUNT(*) as type_count
    FROM relationships
    WHERE deleted_at IS NULL
    GROUP BY relationship_type
  `);

  const by_type: Record<string, number> = {};
  let total = 0;
  let active = 0;

  for (const row of result.rows) {
    by_type[row.relationship_type] = parseInt(row.type_count, 10);
    total += parseInt(row.type_count, 10);
    active += parseInt(row.active, 10);
  }

  return { total, active, by_type };
}

async function getTodayStats(db: Pool): Promise<{
  snapshots: number;
  relationships: number;
}> {
  const result = await db.query(`
    SELECT
      (SELECT COUNT(*) FROM snapshots WHERE created_at >= CURRENT_DATE) as snapshots,
      (SELECT COUNT(*) FROM relationships WHERE created_at >= CURRENT_DATE AND deleted_at IS NULL) as relationships
  `);

  return {
    snapshots: parseInt(result.rows[0].snapshots, 10),
    relationships: parseInt(result.rows[0].relationships, 10),
  };
}
