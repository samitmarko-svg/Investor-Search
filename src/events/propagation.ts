/**
 * Event Propagation
 *
 * Handles event propagation to alerts and notifications.
 * Evaluates alert conditions and creates structured alerts.
 */

import { Pool } from 'pg';
import { EVENT_TAXONOMY, EventConfig } from './taxonomy';

interface EventRow {
  id: string;
  relationship_id: string;
  event_type: string;
  event_category: string;
  event_data: Record<string, unknown>;
  severity: string;
  occurred_at: Date;
}

export class EventPropagator {
  constructor(private db: Pool) {}

  /**
   * Process event and propagate to alerts if conditions met.
   */
  async propagate(event: EventRow): Promise<void> {
    const config = EVENT_TAXONOMY[event.event_type];

    if (!config) {
      console.warn(`Unknown event type: ${event.event_type}`);
      return;
    }

    if (config.triggers_alert && this.meetsAlertConditions(event, config)) {
      await this.createAlert(event, config);
    }
  }

  /**
   * Emit an event and propagate it.
   */
  async emitAndPropagate(
    relationshipId: string,
    eventType: string,
    eventData: Record<string, unknown>,
    severityOverride?: string
  ): Promise<EventRow> {
    const config = EVENT_TAXONOMY[eventType];
    const category = config?.category || 'BEHAVIORAL';
    const severity = severityOverride || config?.severity || 'INFO';

    const result = await this.db.query(
      `INSERT INTO relationship_events
       (relationship_id, event_type, event_category, event_data, severity, occurred_at)
       VALUES ($1, $2, $3, $4, $5, NOW())
       RETURNING *`,
      [relationshipId, eventType, category, JSON.stringify(eventData), severity]
    );

    const event = result.rows[0] as EventRow;
    await this.propagate(event);
    return event;
  }

  private meetsAlertConditions(
    event: EventRow,
    config: EventConfig
  ): boolean {
    const conditions = config.alert_conditions;
    if (!conditions) return true; // No conditions = always alert

    for (const [key, expected] of Object.entries(conditions)) {
      if (key.endsWith('_in')) {
        const fieldName = key.replace('_in', '');
        const value = event.event_data[fieldName];
        if (!Array.isArray(expected) || !expected.includes(value)) {
          return false;
        }
      } else if (key.endsWith('_lt')) {
        const fieldName = key.replace('_lt', '');
        const value = event.event_data[fieldName];
        if (typeof value !== 'number' || typeof expected !== 'number' || value >= expected) {
          return false;
        }
      }
    }

    return true;
  }

  private async createAlert(
    event: EventRow,
    config: EventConfig
  ): Promise<void> {
    const title = this.generateAlertTitle(event);
    const description = this.generateAlertDescription(event);

    await this.db.query(
      `INSERT INTO alerts
       (relationship_id, event_id, alert_type, severity, title, description, visibility, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'ACTIVE')`,
      [
        event.relationship_id,
        event.id,
        event.event_type,
        event.severity,
        title,
        description,
        config.propagate_to,
      ]
    );
  }

  private generateAlertTitle(event: EventRow): string {
    const titles: Record<string, string> = {
      snapshot_missing: 'Missing Snapshot',
      snapshot_delay: 'Late Snapshot Submission',
      ri_significant_change: 'Integrity Score Changed',
      ri_threshold_crossed: 'Integrity Threshold Crossed',
      state_transition: 'Relationship State Changed',
      volatility_detected: 'High Volatility Detected',
      cadence_instability: 'Irregular Submission Pattern',
      forming_timeout: 'Relationship Forming Timeout',
    };

    return titles[event.event_type] || event.event_type.replace(/_/g, ' ');
  }

  private generateAlertDescription(event: EventRow): string {
    const data = event.event_data;

    switch (event.event_type) {
      case 'snapshot_missing': {
        const days = data.days_since_last ?? 0;
        return `No snapshot submitted for ${days} days`;
      }
      case 'ri_significant_change': {
        const delta = data.delta as number ?? 0;
        const direction = delta < 0 ? 'dropped' : 'increased';
        return `Integrity score ${direction} by ${Math.abs(delta)} points`;
      }
      case 'snapshot_delay': {
        const daysLate = data.days_late ?? 0;
        return `Snapshot submitted ${daysLate} days after reporting period`;
      }
      case 'forming_timeout': {
        const daysForming = data.days_forming ?? 0;
        return `Relationship pending for ${daysForming} days without snapshots`;
      }
      default:
        return JSON.stringify(data);
    }
  }
}
