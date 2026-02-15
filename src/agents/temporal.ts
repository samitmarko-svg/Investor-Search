/**
 * Temporal Agent
 *
 * Pattern detection and temporal analysis for relationships.
 * Analyzes volatility, recovery, trajectory, and cadence.
 * Returns structured signals, never crashes.
 */

import { Pool } from 'pg';
import {
  Snapshot,
  TemporalPattern,
  MetricVolatility,
  RecoveryEvent,
} from '../types/relationship_types';

interface TemporalAnalysis {
  volatility: VolatilityResult;
  recovery: RecoveryResult;
  trajectory: TrajectoryResult;
  cadence: CadenceResult;
  snapshots_analyzed: number;
  analysis_timestamp: string;
}

interface VolatilityResult {
  aggregate_score: number;
  by_metric: Record<string, MetricVolatility>;
  classification: string;
}

interface RecoveryResult {
  detected: boolean;
  events: RecoveryEvent[];
  fastest_recovery_days: number | null;
  average_magnitude: number | null;
}

interface TrajectoryResult {
  direction: 'GROWTH' | 'DECLINE' | 'STABLE' | 'VOLATILE';
  slope: number;
  r_squared: number;
}

interface CadenceResult {
  mean_interval_days: number;
  variance: number;
  regularity: 'HIGH' | 'MODERATE' | 'LOW';
  intervals: number[];
}

interface InsufficientDataResult {
  status: 'INSUFFICIENT_DATA';
  snapshots_available: number;
  snapshots_required: number;
}

export class TemporalAgent {
  /**
   * Main entry point for temporal analysis.
   * Returns comprehensive analysis or insufficient data response.
   */
  analyze(snapshots: Snapshot[]): TemporalAnalysis | InsufficientDataResult {
    const sorted = this.sortSnapshots(snapshots);

    if (sorted.length < 2) {
      return {
        status: 'INSUFFICIENT_DATA',
        snapshots_available: sorted.length,
        snapshots_required: 2,
      };
    }

    return {
      volatility: this.analyzeVolatility(sorted),
      recovery: this.analyzeRecovery(sorted),
      trajectory: this.analyzeTrajectory(sorted),
      cadence: this.analyzeCadence(sorted),
      snapshots_analyzed: sorted.length,
      analysis_timestamp: new Date().toISOString(),
    };
  }

  /**
   * Persist temporal analysis to database.
   */
  async persist(
    db: Pool,
    relationshipId: string,
    snapshotId: string,
    analysis: TemporalAnalysis
  ): Promise<TemporalPattern> {
    const result = await db.query(
      `INSERT INTO temporal_patterns (
         relationship_id, snapshot_id,
         volatility_score, volatility_classification, volatility_by_metric,
         recovery_detected, recovery_speed_days, recovery_magnitude, recovery_events,
         trajectory_direction, trajectory_slope, trajectory_r_squared,
         cadence_mean_interval, cadence_variance, cadence_regularity
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
       ON CONFLICT (relationship_id, snapshot_id) DO UPDATE SET
         volatility_score = EXCLUDED.volatility_score,
         volatility_classification = EXCLUDED.volatility_classification,
         volatility_by_metric = EXCLUDED.volatility_by_metric,
         recovery_detected = EXCLUDED.recovery_detected,
         recovery_speed_days = EXCLUDED.recovery_speed_days,
         recovery_magnitude = EXCLUDED.recovery_magnitude,
         recovery_events = EXCLUDED.recovery_events,
         trajectory_direction = EXCLUDED.trajectory_direction,
         trajectory_slope = EXCLUDED.trajectory_slope,
         trajectory_r_squared = EXCLUDED.trajectory_r_squared,
         cadence_mean_interval = EXCLUDED.cadence_mean_interval,
         cadence_variance = EXCLUDED.cadence_variance,
         cadence_regularity = EXCLUDED.cadence_regularity,
         analyzed_at = NOW()
       RETURNING *`,
      [
        relationshipId,
        snapshotId,
        analysis.volatility.aggregate_score,
        analysis.volatility.classification,
        JSON.stringify(analysis.volatility.by_metric),
        analysis.recovery.detected,
        analysis.recovery.fastest_recovery_days,
        analysis.recovery.average_magnitude,
        JSON.stringify(analysis.recovery.events),
        analysis.trajectory.direction,
        analysis.trajectory.slope,
        analysis.trajectory.r_squared,
        analysis.cadence.mean_interval_days,
        analysis.cadence.variance,
        analysis.cadence.regularity,
      ]
    );

    return result.rows[0];
  }

  private sortSnapshots(snapshots: Snapshot[]): Snapshot[] {
    return [...snapshots].sort(
      (a, b) =>
        new Date(a.snapshot_date).getTime() - new Date(b.snapshot_date).getTime()
    );
  }

  // ============================================
  // Volatility Analysis
  // ============================================

  private analyzeVolatility(snapshots: Snapshot[]): VolatilityResult {
    const metrics = ['revenue', 'burn_rate', 'runway_months'];
    const volatilities: Record<string, MetricVolatility> = {};

    for (const metric of metrics) {
      const values = this.extractMetricValues(snapshots, metric);

      if (values.length === 0 || values.every((v) => v === 0)) {
        volatilities[metric] = {
          score: 0,
          mean: 0,
          std_dev: 0,
          classification: 'STABLE',
          reason: values.length === 0 ? 'NO_DATA' : 'ALL_ZERO',
        };
        continue;
      }

      const mean = values.reduce((a, b) => a + b, 0) / values.length;
      const variance =
        values.reduce((sum, v) => sum + Math.pow(v - mean, 2), 0) / values.length;
      const stdDev = Math.sqrt(variance);
      const cv = mean !== 0 ? stdDev / Math.abs(mean) : 0;

      volatilities[metric] = {
        score: Math.round(cv * 10000) / 10000,
        mean: Math.round(mean * 100) / 100,
        std_dev: Math.round(stdDev * 100) / 100,
        classification: this.classifyVolatility(cv),
      };
    }

    const nonZero = Object.values(volatilities)
      .map((v) => v.score)
      .filter((s) => s > 0);
    const avgVolatility =
      nonZero.length > 0
        ? nonZero.reduce((a, b) => a + b, 0) / nonZero.length
        : 0;

    return {
      aggregate_score: Math.round(avgVolatility * 10000) / 10000,
      by_metric: volatilities,
      classification: this.classifyVolatility(avgVolatility),
    };
  }

  private classifyVolatility(score: number): string {
    if (score < 0.1) return 'STABLE';
    if (score < 0.3) return 'MODERATE';
    if (score < 0.5) return 'HIGH';
    return 'EXTREME';
  }

  // ============================================
  // Recovery Analysis
  // ============================================

  private analyzeRecovery(snapshots: Snapshot[]): RecoveryResult {
    const events: RecoveryEvent[] = [];
    const metrics = ['revenue', 'burn_rate', 'runway_months'];

    for (const metric of metrics) {
      const values = this.extractMetricValues(snapshots, metric);
      if (values.length < 3) continue;

      for (let i = 1; i < values.length - 1; i++) {
        const prev = values[i - 1];
        const curr = values[i];
        const next = values[i + 1];

        if (prev === 0) continue;

        // Detect drop > 20%
        const dropPct = (prev - curr) / Math.abs(prev);
        if (dropPct > 0.2 && next > curr) {
          const recoveryPct =
            curr !== 0 ? (next - curr) / Math.abs(curr) : 0;

          events.push({
            metric,
            drop_magnitude: Math.round(dropPct * 10000) / 10000,
            recovery_magnitude: Math.round(recoveryPct * 10000) / 10000,
            recovery_days: this.daysBetween(
              snapshots[i].snapshot_date,
              snapshots[i + 1].snapshot_date
            ),
          });
        }
      }
    }

    const recoveryDays = events
      .map((e) => e.recovery_days)
      .filter((d) => d > 0);
    const avgMagnitude =
      events.length > 0
        ? events.reduce((s, e) => s + e.recovery_magnitude, 0) / events.length
        : null;

    return {
      detected: events.length > 0,
      events,
      fastest_recovery_days:
        recoveryDays.length > 0 ? Math.min(...recoveryDays) : null,
      average_magnitude: avgMagnitude
        ? Math.round(avgMagnitude * 10000) / 10000
        : null,
    };
  }

  // ============================================
  // Trajectory Analysis
  // ============================================

  private analyzeTrajectory(snapshots: Snapshot[]): TrajectoryResult {
    const values = this.extractMetricValues(snapshots, 'revenue');

    if (values.length < 2) {
      return { direction: 'STABLE', slope: 0, r_squared: 0 };
    }

    // Linear regression
    const n = values.length;
    const x = Array.from({ length: n }, (_, i) => i);
    const xMean = (n - 1) / 2;
    const yMean = values.reduce((a, b) => a + b, 0) / n;

    let num = 0;
    let denX = 0;
    let denY = 0;

    for (let i = 0; i < n; i++) {
      const dx = x[i] - xMean;
      const dy = values[i] - yMean;
      num += dx * dy;
      denX += dx * dx;
      denY += dy * dy;
    }

    const slope = denX !== 0 ? num / denX : 0;
    const rSquared = denX !== 0 && denY !== 0 ? Math.pow(num, 2) / (denX * denY) : 0;

    // Determine direction
    let direction: 'GROWTH' | 'DECLINE' | 'STABLE' | 'VOLATILE';
    if (rSquared < 0.3) {
      direction = 'VOLATILE';
    } else if (Math.abs(slope) < yMean * 0.01) {
      direction = 'STABLE';
    } else if (slope > 0) {
      direction = 'GROWTH';
    } else {
      direction = 'DECLINE';
    }

    return {
      direction,
      slope: Math.round(slope * 100) / 100,
      r_squared: Math.round(rSquared * 10000) / 10000,
    };
  }

  // ============================================
  // Cadence Analysis
  // ============================================

  private analyzeCadence(snapshots: Snapshot[]): CadenceResult {
    const dates = snapshots.map((s) => new Date(s.snapshot_date));
    const intervals: number[] = [];

    for (let i = 0; i < dates.length - 1; i++) {
      intervals.push(this.daysBetween(dates[i], dates[i + 1]));
    }

    if (intervals.length === 0) {
      return {
        mean_interval_days: 0,
        variance: 0,
        regularity: 'LOW',
        intervals: [],
      };
    }

    const mean = intervals.reduce((a, b) => a + b, 0) / intervals.length;
    const variance =
      intervals.reduce((sum, x) => sum + Math.pow(x - mean, 2), 0) /
      intervals.length;

    let regularity: 'HIGH' | 'MODERATE' | 'LOW';
    if (variance < 25) {
      regularity = 'HIGH';
    } else if (variance < 100) {
      regularity = 'MODERATE';
    } else {
      regularity = 'LOW';
    }

    return {
      mean_interval_days: Math.round(mean * 10) / 10,
      variance: Math.round(variance * 100) / 100,
      regularity,
      intervals,
    };
  }

  // ============================================
  // Helpers
  // ============================================

  private extractMetricValues(snapshots: Snapshot[], metric: string): number[] {
    const values: number[] = [];
    for (const s of snapshots) {
      const val =
        (s.financials as Record<string, unknown>)?.[metric] ??
        (s.declarations as Record<string, unknown>)?.[metric];
      if (typeof val === 'number') {
        values.push(val);
      }
    }
    return values;
  }

  private daysBetween(a: Date | string, b: Date | string): number {
    const dateA = new Date(a);
    const dateB = new Date(b);
    return Math.round(
      Math.abs(dateB.getTime() - dateA.getTime()) / (1000 * 60 * 60 * 24)
    );
  }
}
