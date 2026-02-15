/**
 * Silence and Latency Detection
 *
 * Detects missing snapshots, delays, and cadence volatility.
 * Runs periodically to check all active relationships.
 */

import { Pool } from 'pg';

const DEFAULT_EXPECTED_CADENCE = 30; // days
const DELAY_THRESHOLD = 7; // days

interface SilenceCheckResult {
  relationship_id: string;
  events_emitted: string[];
}

export class SilenceDetector {
  constructor(private db: Pool) {}

  /**
   * Check all active relationships for silence/delays.
   */
  async detectAll(): Promise<SilenceCheckResult[]> {
    const results: SilenceCheckResult[] = [];

    const activeRelationships = await this.db.query(
      `SELECT * FROM relationships
       WHERE status IN ('PENDING', 'ACTIVE', 'PAUSED')
       AND deleted_at IS NULL`
    );

    for (const relationship of activeRelationships.rows) {
      try {
        const result = await this.detect(relationship);
        results.push(result);
      } catch (err) {
        console.error(
          `Silence detection failed for relationship ${relationship.id}:`,
          err instanceof Error ? err.message : err
        );
      }
    }

    return results;
  }

  /**
   * Detect silence and latency for a single relationship.
   */
  async detect(relationship: Record<string, unknown>): Promise<SilenceCheckResult> {
    const relationshipId = relationship.id as string;
    const eventsEmitted: string[] = [];

    const expectedDays = this.getExpectedCadence(relationship);

    // Get last processed snapshot
    const lastSnapshot = await this.db.query(
      `SELECT * FROM snapshots
       WHERE relationship_id = $1 AND status = 'PROCESSED'
       ORDER BY snapshot_date DESC LIMIT 1`,
      [relationshipId]
    );

    if (lastSnapshot.rows.length === 0) {
      const noSnapshotEvents = await this.handleNoSnapshots(relationship);
      eventsEmitted.push(...noSnapshotEvents);
      return { relationship_id: relationshipId, events_emitted: eventsEmitted };
    }

    const snapshot = lastSnapshot.rows[0];
    const snapshotDate = new Date(snapshot.snapshot_date);
    const daysSince = Math.floor(
      (Date.now() - snapshotDate.getTime()) / (1000 * 60 * 60 * 24)
    );

    // Check silence (no snapshot for longer than expected cadence)
    if (daysSince > expectedDays) {
      const severity = daysSince > expectedDays * 2 ? 'CRITICAL' : 'WARNING';

      await this.emitEvent(relationshipId, 'snapshot_missing', 'BEHAVIORAL', {
        days_since_last: daysSince,
        expected_cadence: expectedDays,
        overdue_by: daysSince - expectedDays,
      }, severity);

      eventsEmitted.push('snapshot_missing');
    }

    // Check delay (snapshot submitted late relative to snapshot_date)
    if (snapshot.created_at && snapshot.snapshot_date) {
      const createdAt = new Date(snapshot.created_at);
      const snapshotDateObj = new Date(snapshot.snapshot_date);
      const daysLate = Math.floor(
        (createdAt.getTime() - snapshotDateObj.getTime()) / (1000 * 60 * 60 * 24)
      );

      if (daysLate > DELAY_THRESHOLD) {
        await this.emitEvent(relationshipId, 'snapshot_delay', 'BEHAVIORAL', {
          snapshot_id: snapshot.id,
          snapshot_date: snapshot.snapshot_date,
          submitted_at: snapshot.created_at,
          days_late: daysLate,
        }, 'WARNING');

        eventsEmitted.push('snapshot_delay');
      }
    }

    // Check cadence volatility
    const cadenceEvents = await this.checkCadenceVolatility(relationshipId);
    eventsEmitted.push(...cadenceEvents);

    return { relationship_id: relationshipId, events_emitted: eventsEmitted };
  }

  private getExpectedCadence(relationship: Record<string, unknown>): number {
    const metadata = relationship.metadata as Record<string, unknown> | null;
    if (metadata && typeof metadata.expected_cadence_days === 'number') {
      return metadata.expected_cadence_days;
    }
    return DEFAULT_EXPECTED_CADENCE;
  }

  private async handleNoSnapshots(
    relationship: Record<string, unknown>
  ): Promise<string[]> {
    const events: string[] = [];
    const status = relationship.status as string;

    if (status === 'PENDING') {
      const createdAt = new Date(relationship.created_at as string);
      const daysForming = Math.floor(
        (Date.now() - createdAt.getTime()) / (1000 * 60 * 60 * 24)
      );

      if (daysForming > 30) {
        await this.emitEvent(
          relationship.id as string,
          'forming_timeout',
          'LIFECYCLE',
          {
            days_forming: daysForming,
            snapshots_submitted: 0,
          },
          'WARNING'
        );
        events.push('forming_timeout');
      }
    }

    return events;
  }

  private async checkCadenceVolatility(
    relationshipId: string
  ): Promise<string[]> {
    const events: string[] = [];

    const snapshots = await this.db.query(
      `SELECT snapshot_date FROM snapshots
       WHERE relationship_id = $1 AND status = 'PROCESSED'
       ORDER BY snapshot_date ASC`,
      [relationshipId]
    );

    if (snapshots.rows.length < 3) return events;

    const dates = snapshots.rows.map(
      (r: Record<string, unknown>) => new Date(r.snapshot_date as string)
    );
    const intervals: number[] = [];

    for (let i = 0; i < dates.length - 1; i++) {
      intervals.push(
        Math.floor(
          (dates[i + 1].getTime() - dates[i].getTime()) / (1000 * 60 * 60 * 24)
        )
      );
    }

    const mean = intervals.reduce((a, b) => a + b, 0) / intervals.length;
    const variance =
      intervals.reduce((sum, x) => sum + Math.pow(x - mean, 2), 0) /
      intervals.length;

    if (variance > 100) {
      await this.emitEvent(
        relationshipId,
        'cadence_instability',
        'PATTERN',
        {
          mean_interval: Math.round(mean * 10) / 10,
          variance: Math.round(variance * 100) / 100,
          intervals,
          classification: 'IRREGULAR',
        },
        'INFO'
      );
      events.push('cadence_instability');
    }

    return events;
  }

  private async emitEvent(
    relationshipId: string,
    eventType: string,
    category: string,
    data: Record<string, unknown>,
    severity: string
  ): Promise<void> {
    await this.db.query(
      `INSERT INTO relationship_events
       (relationship_id, event_type, event_category, event_data, severity, occurred_at)
       VALUES ($1, $2, $3, $4, $5, NOW())`,
      [relationshipId, eventType, category, JSON.stringify(data), severity]
    );
  }
}
