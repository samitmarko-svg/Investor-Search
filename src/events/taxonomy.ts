/**
 * Event Taxonomy
 *
 * Defines all event types, their categories, and propagation rules.
 */

export interface EventConfig {
  category: 'LIFECYCLE' | 'BEHAVIORAL' | 'INTEGRITY' | 'PATTERN';
  severity: 'INFO' | 'WARNING' | 'CRITICAL';
  propagate_to: 'BOTH_PARTIES' | 'FOUNDER_ONLY' | 'INVESTOR_ONLY';
  triggers_alert: boolean;
  alert_conditions?: Record<string, unknown>;
}

export const EVENT_TAXONOMY: Record<string, EventConfig> = {
  // Lifecycle Events
  intent_expressed: {
    category: 'LIFECYCLE',
    severity: 'INFO',
    propagate_to: 'BOTH_PARTIES',
    triggers_alert: false,
  },
  intent_accepted: {
    category: 'LIFECYCLE',
    severity: 'INFO',
    propagate_to: 'BOTH_PARTIES',
    triggers_alert: false,
  },
  relationship_activated: {
    category: 'LIFECYCLE',
    severity: 'INFO',
    propagate_to: 'BOTH_PARTIES',
    triggers_alert: false,
  },
  state_transition: {
    category: 'LIFECYCLE',
    severity: 'WARNING',
    propagate_to: 'BOTH_PARTIES',
    triggers_alert: true,
    alert_conditions: { to_state_in: ['PAUSED', 'TERMINATED'] },
  },
  forming_timeout: {
    category: 'LIFECYCLE',
    severity: 'WARNING',
    propagate_to: 'BOTH_PARTIES',
    triggers_alert: true,
  },

  // Snapshot Events
  snapshot_submitted: {
    category: 'BEHAVIORAL',
    severity: 'INFO',
    propagate_to: 'BOTH_PARTIES',
    triggers_alert: false,
  },
  snapshot_processed: {
    category: 'BEHAVIORAL',
    severity: 'INFO',
    propagate_to: 'FOUNDER_ONLY',
    triggers_alert: false,
  },
  snapshot_delay: {
    category: 'BEHAVIORAL',
    severity: 'WARNING',
    propagate_to: 'BOTH_PARTIES',
    triggers_alert: true,
  },
  snapshot_missing: {
    category: 'BEHAVIORAL',
    severity: 'CRITICAL',
    propagate_to: 'BOTH_PARTIES',
    triggers_alert: true,
  },

  // Integrity Events
  ri_calculated: {
    category: 'INTEGRITY',
    severity: 'INFO',
    propagate_to: 'BOTH_PARTIES',
    triggers_alert: false,
  },
  ri_significant_change: {
    category: 'INTEGRITY',
    severity: 'WARNING',
    propagate_to: 'BOTH_PARTIES',
    triggers_alert: true,
    alert_conditions: { delta_lt: -10 },
  },
  ri_threshold_crossed: {
    category: 'INTEGRITY',
    severity: 'CRITICAL',
    propagate_to: 'BOTH_PARTIES',
    triggers_alert: true,
  },

  // Pattern Events
  volatility_detected: {
    category: 'PATTERN',
    severity: 'WARNING',
    propagate_to: 'BOTH_PARTIES',
    triggers_alert: true,
    alert_conditions: { classification_in: ['HIGH', 'EXTREME'] },
  },
  recovery_detected: {
    category: 'PATTERN',
    severity: 'INFO',
    propagate_to: 'BOTH_PARTIES',
    triggers_alert: false,
  },
  cadence_instability: {
    category: 'PATTERN',
    severity: 'WARNING',
    propagate_to: 'BOTH_PARTIES',
    triggers_alert: true,
  },
};
