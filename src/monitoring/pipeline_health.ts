/**
 * Pipeline Health Monitoring
 *
 * Provides system health metrics and pipeline status.
 */

import { Pool } from 'pg';

export interface PipelineHealth {
  pipeline: {
    processing: number;
    processed: number;
    failed: number;
    avg_processing_time_seconds: number | null;
  };
  events: {
    total_24h: number;
    by_severity: Record<string, number>;
  };
  alerts: {
    active: number;
    recent: Array<Record<string, unknown>>;
  };
  relationships: {
    total: number;
    active: number;
    pending: number;
    paused: number;
  };
  scheduler: Array<{ name: string; interval_hours: number; last_run: string | null }>;
}

export async function collectPipelineHealth(db: Pool): Promise<PipelineHealth> {
  const [pipeline, events, alerts, relationships] = await Promise.all([
    getPipelineStats(db),
    getEventStats(db),
    getAlertStats(db),
    getRelationshipStats(db),
  ]);

  return {
    pipeline,
    events,
    alerts,
    relationships,
    scheduler: [], // Populated by caller with scheduler status
  };
}

async function getPipelineStats(db: Pool): Promise<PipelineHealth['pipeline']> {
  try {
    const result = await db.query(`
      SELECT
        COUNT(*) FILTER (WHERE status = 'PROCESSING') as processing,
        COUNT(*) FILTER (WHERE status = 'PROCESSED') as processed,
        COUNT(*) FILTER (WHERE status = 'FAILED') as failed,
        AVG(
          CASE WHEN status = 'PROCESSED' AND processed_at IS NOT NULL
          THEN EXTRACT(EPOCH FROM (processed_at - created_at))
          END
        ) as avg_time
      FROM snapshots
      WHERE created_at > NOW() - INTERVAL '24 hours'
    `);

    const row = result.rows[0];
    return {
      processing: parseInt(row.processing, 10) || 0,
      processed: parseInt(row.processed, 10) || 0,
      failed: parseInt(row.failed, 10) || 0,
      avg_processing_time_seconds: row.avg_time
        ? Math.round(parseFloat(row.avg_time) * 100) / 100
        : null,
    };
  } catch {
    return { processing: 0, processed: 0, failed: 0, avg_processing_time_seconds: null };
  }
}

async function getEventStats(db: Pool): Promise<PipelineHealth['events']> {
  try {
    const result = await db.query(`
      SELECT
        COUNT(*) as total,
        COUNT(*) FILTER (WHERE severity = 'CRITICAL') as critical,
        COUNT(*) FILTER (WHERE severity = 'WARNING') as warning,
        COUNT(*) FILTER (WHERE severity = 'INFO') as info
      FROM relationship_events
      WHERE occurred_at > NOW() - INTERVAL '24 hours'
    `);

    const row = result.rows[0];
    return {
      total_24h: parseInt(row.total, 10) || 0,
      by_severity: {
        critical: parseInt(row.critical, 10) || 0,
        warning: parseInt(row.warning, 10) || 0,
        info: parseInt(row.info, 10) || 0,
      },
    };
  } catch {
    return { total_24h: 0, by_severity: { critical: 0, warning: 0, info: 0 } };
  }
}

async function getAlertStats(db: Pool): Promise<PipelineHealth['alerts']> {
  try {
    const countResult = await db.query(
      `SELECT COUNT(*) as count FROM alerts WHERE status = 'ACTIVE'`
    );

    const recentResult = await db.query(
      `SELECT * FROM alerts ORDER BY created_at DESC LIMIT 10`
    );

    return {
      active: parseInt(countResult.rows[0].count, 10) || 0,
      recent: recentResult.rows,
    };
  } catch {
    return { active: 0, recent: [] };
  }
}

async function getRelationshipStats(db: Pool): Promise<PipelineHealth['relationships']> {
  try {
    const result = await db.query(`
      SELECT
        COUNT(*) as total,
        COUNT(*) FILTER (WHERE status = 'ACTIVE') as active,
        COUNT(*) FILTER (WHERE status = 'PENDING') as pending,
        COUNT(*) FILTER (WHERE status = 'PAUSED') as paused
      FROM relationships
      WHERE deleted_at IS NULL
    `);

    const row = result.rows[0];
    return {
      total: parseInt(row.total, 10) || 0,
      active: parseInt(row.active, 10) || 0,
      pending: parseInt(row.pending, 10) || 0,
      paused: parseInt(row.paused, 10) || 0,
    };
  } catch {
    return { total: 0, active: 0, pending: 0, paused: 0 };
  }
}
