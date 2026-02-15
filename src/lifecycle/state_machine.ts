/**
 * Lifecycle State Machine
 *
 * Manages relationship state transitions based on
 * integrity scores, temporal signals, and events.
 *
 * States: PENDING → ACTIVE → PAUSED/TERMINATED
 * (ACTIVE can also transition back from PAUSED)
 */

import { Pool } from 'pg';
import { IntegrityScore, TemporalPattern } from '../types/relationship_types';
import { TemporalSignalConverter } from '../signals/temporal_signals';
import { EventPropagator } from '../events/propagation';

export class LifecycleStateMachine {
  private signalConverter: TemporalSignalConverter;
  private eventPropagator: EventPropagator;

  constructor(private db: Pool) {
    this.signalConverter = new TemporalSignalConverter();
    this.eventPropagator = new EventPropagator(db);
  }

  /**
   * Evaluate whether a state transition should occur.
   * Triggers transition and emits events if needed.
   */
  async evaluateTransition(
    relationshipId: string,
    latestRI: IntegrityScore
  ): Promise<string | null> {
    const relResult = await this.db.query(
      'SELECT * FROM relationships WHERE id = $1 AND deleted_at IS NULL',
      [relationshipId]
    );

    if (relResult.rows.length === 0) return null;

    const relationship = relResult.rows[0];
    const currentState = relationship.status as string;

    // Get latest temporal pattern
    const patternResult = await this.db.query(
      `SELECT * FROM temporal_patterns
       WHERE relationship_id = $1
       ORDER BY analyzed_at DESC LIMIT 1`,
      [relationshipId]
    );

    const pattern = patternResult.rows.length > 0
      ? (patternResult.rows[0] as TemporalPattern)
      : null;

    const signals = this.signalConverter.convert(pattern);
    const newState = this.determineTransition(currentState, latestRI, signals);

    if (newState && newState !== currentState) {
      await this.applyTransition(relationshipId, currentState, newState);
      return newState;
    }

    return null;
  }

  private determineTransition(
    currentState: string,
    ri: IntegrityScore,
    signals: { entropy: number | null; stability: number | null; recovery_capacity: number }
  ): string | null {
    switch (currentState) {
      case 'PENDING':
        // PENDING → ACTIVE (handled by snapshot-first guardrail)
        return null;

      case 'ACTIVE':
        // ACTIVE → PAUSED (low integrity or high entropy)
        if (ri.smi < 40) {
          return 'PAUSED';
        }
        if (signals.entropy !== null && signals.entropy > 0.8 && ri.smi < 60) {
          return 'PAUSED';
        }
        return null;

      case 'PAUSED':
        // PAUSED → ACTIVE (recovery)
        if (ri.smi > 70 && signals.recovery_capacity > 0.7) {
          return 'ACTIVE';
        }
        // PAUSED → TERMINATED (continued decline)
        if (ri.smi < 20) {
          return 'TERMINATED';
        }
        return null;

      default:
        return null;
    }
  }

  private async applyTransition(
    relationshipId: string,
    fromState: string,
    toState: string
  ): Promise<void> {
    const updateFields: Record<string, string> = {
      ACTIVE: `status = 'ACTIVE', activated_at = NOW()`,
      PAUSED: `status = 'PAUSED'`,
      TERMINATED: `status = 'TERMINATED', terminated_at = NOW()`,
    };

    const updateClause = updateFields[toState];
    if (!updateClause) return;

    await this.db.query(
      `UPDATE relationships SET ${updateClause} WHERE id = $1`,
      [relationshipId]
    );

    await this.eventPropagator.emitAndPropagate(
      relationshipId,
      'state_transition',
      {
        from_state: fromState,
        to_state: toState,
      },
      toState === 'TERMINATED' ? 'CRITICAL' : 'WARNING'
    );
  }
}
