/**
 * Snapshot Processing Pipeline
 *
 * Runs: Validation → Storage → Interpreter → Temporal → Reducer → Events → State
 * Returns 202 immediately, processes asynchronously.
 */

import { Pool } from 'pg';
import {
  Snapshot,
  SnapshotData,
  IntegrityScore,
  PipelineResult,
} from '../types/relationship_types';
import { calculateIntegrityForType } from '../integrity/calculator';
import { TemporalAgent } from '../agents/temporal';
import { EventPropagator } from '../events/propagation';
import { SnapshotValidator } from '../validation/snapshot_validator';
import { LifecycleStateMachine } from '../lifecycle/state_machine';

const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 5000;

export class SnapshotPipeline {
  private temporalAgent: TemporalAgent;
  private eventPropagator: EventPropagator;
  private validator: SnapshotValidator;
  private stateMachine: LifecycleStateMachine;

  constructor(private db: Pool) {
    this.temporalAgent = new TemporalAgent();
    this.eventPropagator = new EventPropagator(db);
    this.validator = new SnapshotValidator();
    this.stateMachine = new LifecycleStateMachine(db);
  }

  /**
   * Submit a snapshot for async processing.
   * Returns immediately with PROCESSING status.
   */
  async submit(
    relationshipId: string,
    snapshotData: SnapshotData,
    submittedByEntityId?: string
  ): Promise<{ id: string; status: string }> {
    // Get relationship
    const relResult = await this.db.query(
      'SELECT * FROM relationships WHERE id = $1 AND deleted_at IS NULL',
      [relationshipId]
    );

    if (relResult.rows.length === 0) {
      throw new Error('Relationship not found');
    }

    const relationship = relResult.rows[0];

    // Run validation
    const validation = await this.validator.validate(
      {
        snapshot_date: snapshotData.snapshot_date,
        declarations: snapshotData.declarations,
        financials: snapshotData.financials,
      },
      relationshipId,
      relationship.relationship_type,
      this.db
    );

    if (!validation.is_valid) {
      throw new ValidationFailedError(validation.errors);
    }

    // Store with PROCESSING status
    const snapshotResult = await this.db.query(
      `INSERT INTO snapshots (
         relationship_id, snapshot_date, declarations, financials,
         context_notes, status, submitted_by_entity_id, created_at
       ) VALUES ($1, $2, $3, $4, $5, 'PROCESSING', $6, NOW())
       RETURNING *`,
      [
        relationshipId,
        snapshotData.snapshot_date,
        JSON.stringify(snapshotData.declarations),
        JSON.stringify(snapshotData.financials),
        snapshotData.context_notes || null,
        submittedByEntityId || null,
      ]
    );

    const snapshot = snapshotResult.rows[0];

    // Emit submission event
    await this.eventPropagator.emitAndPropagate(
      relationshipId,
      'snapshot_submitted',
      {
        snapshot_id: snapshot.id,
        snapshot_date: snapshotData.snapshot_date,
        validation_warnings: validation.warnings,
      }
    );

    // Trigger async processing (using setImmediate for non-blocking)
    setImmediate(() => {
      this.processWithRetry(snapshot.id, 0).catch((err) => {
        console.error(
          `Pipeline failed for snapshot ${snapshot.id}:`,
          err instanceof Error ? err.message : err
        );
      });
    });

    return {
      id: snapshot.id,
      status: 'PROCESSING',
    };
  }

  /**
   * Process a snapshot through the full pipeline with retry logic.
   */
  private async processWithRetry(
    snapshotId: string,
    attempt: number
  ): Promise<void> {
    try {
      await this.process(snapshotId);
    } catch (err) {
      if (attempt < MAX_RETRIES) {
        const delay = RETRY_DELAY_MS * Math.pow(2, attempt);
        console.warn(
          `Pipeline retry ${attempt + 1}/${MAX_RETRIES} for snapshot ${snapshotId} in ${delay}ms`
        );
        await new Promise((resolve) => setTimeout(resolve, delay));
        await this.processWithRetry(snapshotId, attempt + 1);
      } else {
        // Mark as failed
        await this.db.query(
          `UPDATE snapshots SET status = 'FAILED', error_message = $2
           WHERE id = $1`,
          [snapshotId, err instanceof Error ? err.message : 'Unknown error']
        );
        throw err;
      }
    }
  }

  /**
   * Full pipeline execution for a single snapshot.
   */
  async process(snapshotId: string): Promise<PipelineResult> {
    const eventsEmitted: string[] = [];

    // Load snapshot and relationship
    const snapshotResult = await this.db.query(
      'SELECT * FROM snapshots WHERE id = $1',
      [snapshotId]
    );
    const snapshot = snapshotResult.rows[0] as Snapshot;

    const relResult = await this.db.query(
      'SELECT * FROM relationships WHERE id = $1 AND deleted_at IS NULL',
      [snapshot.relationship_id]
    );
    const relationship = relResult.rows[0];

    // Step 1: Get all snapshots for this relationship
    const allSnapshotsResult = await this.db.query(
      `SELECT * FROM snapshots
       WHERE relationship_id = $1
       ORDER BY snapshot_date DESC`,
      [snapshot.relationship_id]
    );
    const allSnapshots = allSnapshotsResult.rows as Snapshot[];

    // Step 2: Calculate integrity score (Reducer)
    const integrityScore = calculateIntegrityForType(relationship, allSnapshots);

    await this.db.query(
      `INSERT INTO integrity_scores (
         relationship_id, snapshot_id, smi, components, calculated_at
       ) VALUES ($1, $2, $3, $4, NOW())`,
      [
        snapshot.relationship_id,
        snapshotId,
        integrityScore.smi,
        JSON.stringify(integrityScore.components),
      ]
    );

    // Step 3: Temporal analysis
    let temporalPattern = undefined;
    const temporalAnalysis = this.temporalAgent.analyze(allSnapshots);

    if ('status' in temporalAnalysis && temporalAnalysis.status === 'INSUFFICIENT_DATA') {
      // Not enough data for temporal analysis, skip
    } else {
      temporalPattern = await this.temporalAgent.persist(
        this.db,
        snapshot.relationship_id,
        snapshotId,
        temporalAnalysis as Exclude<typeof temporalAnalysis, { status: string }>
      );

      // Emit pattern events
      const analysis = temporalAnalysis as Exclude<typeof temporalAnalysis, { status: string }>;
      if (
        analysis.volatility.classification === 'HIGH' ||
        analysis.volatility.classification === 'EXTREME'
      ) {
        await this.eventPropagator.emitAndPropagate(
          snapshot.relationship_id,
          'volatility_detected',
          {
            classification: analysis.volatility.classification,
            aggregate_score: analysis.volatility.aggregate_score,
          }
        );
        eventsEmitted.push('volatility_detected');
      }

      if (analysis.recovery.detected) {
        await this.eventPropagator.emitAndPropagate(
          snapshot.relationship_id,
          'recovery_detected',
          {
            events_count: analysis.recovery.events.length,
            fastest_recovery_days: analysis.recovery.fastest_recovery_days,
          }
        );
        eventsEmitted.push('recovery_detected');
      }
    }

    // Step 4: Emit RI events
    await this.eventPropagator.emitAndPropagate(
      snapshot.relationship_id,
      'ri_calculated',
      {
        smi: integrityScore.smi,
        components: integrityScore.components,
        snapshot_id: snapshotId,
      }
    );
    eventsEmitted.push('ri_calculated');

    // Check for significant RI change
    await this.checkRIChange(snapshot.relationship_id, integrityScore, eventsEmitted);

    // Step 5: Check state transitions
    await this.stateMachine.evaluateTransition(
      snapshot.relationship_id,
      integrityScore
    );

    // Step 6: Emit processed event
    await this.eventPropagator.emitAndPropagate(
      snapshot.relationship_id,
      'snapshot_processed',
      { snapshot_id: snapshotId, smi: integrityScore.smi }
    );
    eventsEmitted.push('snapshot_processed');

    // Step 7: Finalize
    await this.db.query(
      `UPDATE snapshots SET status = 'PROCESSED', processed_at = NOW()
       WHERE id = $1`,
      [snapshotId]
    );

    return {
      snapshot_id: snapshotId,
      status: 'PROCESSED',
      integrity_score: integrityScore,
      temporal_pattern: temporalPattern,
      events_emitted: eventsEmitted,
    };
  }

  private async checkRIChange(
    relationshipId: string,
    currentRI: IntegrityScore,
    eventsEmitted: string[]
  ): Promise<void> {
    const prevResult = await this.db.query(
      `SELECT smi FROM integrity_scores
       WHERE relationship_id = $1
       ORDER BY calculated_at DESC
       OFFSET 1 LIMIT 1`,
      [relationshipId]
    );

    if (prevResult.rows.length > 0) {
      const prevSmi = prevResult.rows[0].smi;
      const delta = currentRI.smi - prevSmi;

      if (Math.abs(delta) > 10) {
        await this.eventPropagator.emitAndPropagate(
          relationshipId,
          'ri_significant_change',
          {
            previous_ri: prevSmi,
            current_ri: currentRI.smi,
            delta: Math.round(delta * 100) / 100,
          },
          delta < 0 ? 'WARNING' : 'INFO'
        );
        eventsEmitted.push('ri_significant_change');
      }

      // Check threshold crossing
      const thresholds = [80, 60, 40];
      for (const threshold of thresholds) {
        if (
          (prevSmi >= threshold && currentRI.smi < threshold) ||
          (prevSmi < threshold && currentRI.smi >= threshold)
        ) {
          await this.eventPropagator.emitAndPropagate(
            relationshipId,
            'ri_threshold_crossed',
            {
              threshold,
              previous_ri: prevSmi,
              current_ri: currentRI.smi,
              direction: currentRI.smi < threshold ? 'BELOW' : 'ABOVE',
            },
            currentRI.smi < threshold ? 'CRITICAL' : 'INFO'
          );
          eventsEmitted.push('ri_threshold_crossed');
          break;
        }
      }
    }
  }
}

export class ValidationFailedError extends Error {
  constructor(public errors: Array<{ field: string; error: string; message: string }>) {
    super('Validation failed');
    this.name = 'ValidationFailedError';
  }
}
