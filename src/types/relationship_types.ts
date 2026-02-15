/**
 * Relationship Type Registry
 *
 * Defines all supported relationship types and their validation rules.
 * Every relationship type MUST implement integrity calculation.
 */

export interface RelationshipType {
  type: string;
  label: string;
  roles: { a: string; b: string };
  requiredFields: string[];
  snapshotSchema: Record<string, FieldDefinition>;
}

export interface FieldDefinition {
  type: 'string' | 'number' | 'boolean' | 'date' | 'object';
  required: boolean;
  description: string;
}

export interface Relationship {
  id: string;
  entity_a_id: string;
  entity_b_id: string;
  role_a: string;
  role_b: string;
  relationship_type: string;
  status: 'PENDING' | 'ACTIVE' | 'PAUSED' | 'TERMINATED';
  created_at: Date;
  activated_at?: Date;
  terminated_at?: Date;
  updated_at: Date;
  deleted_at?: Date;
  created_by?: string;
  metadata: Record<string, unknown>;
}

export interface Snapshot {
  id: string;
  relationship_id: string;
  snapshot_date: Date;
  declarations: Record<string, unknown>;
  financials: Record<string, unknown>;
  context_notes?: string;
  created_at: Date;
}

export interface IntegrityScore {
  smi: number;
  components: Record<string, number>;
}

export interface SnapshotData {
  snapshot_date: Date;
  declarations: Record<string, unknown>;
  financials: Record<string, unknown>;
  context_notes?: string;
}

export interface RelationshipAlignment {
  id: string;
  relationship_id: string;
  alignment_type: string;
  alignment_data: Record<string, unknown>;
  status: 'ACTIVE' | 'EXPIRED' | 'SUPERSEDED';
  valid_from: Date;
  valid_until?: Date;
  created_at: Date;
  updated_at: Date;
  created_by?: string;
  notes?: string;
}

export interface RelationshipEvent {
  id: string;
  relationship_id: string;
  event_type: string;
  event_category: 'LIFECYCLE' | 'BEHAVIORAL' | 'INTEGRITY' | 'PATTERN';
  event_data: Record<string, unknown>;
  severity: 'INFO' | 'WARNING' | 'CRITICAL';
  occurred_at: Date;
  created_at: Date;
}

export interface ConversationTrigger {
  relationship_id: string;
  trigger_condition: string;
  triggered_at?: Date;
  resolved_at?: Date;
}

// ============================================
// Temporal Pattern Types
// ============================================

export interface TemporalPattern {
  id: string;
  relationship_id: string;
  snapshot_id: string;

  volatility_score: number | null;
  volatility_classification: 'STABLE' | 'MODERATE' | 'HIGH' | 'EXTREME' | null;
  volatility_by_metric: Record<string, MetricVolatility>;

  recovery_detected: boolean;
  recovery_speed_days: number | null;
  recovery_magnitude: number | null;
  recovery_events: RecoveryEvent[];

  trajectory_direction: 'GROWTH' | 'DECLINE' | 'STABLE' | 'VOLATILE' | null;
  trajectory_slope: number | null;
  trajectory_r_squared: number | null;

  cadence_mean_interval: number | null;
  cadence_variance: number | null;
  cadence_regularity: 'HIGH' | 'MODERATE' | 'LOW' | null;

  analyzed_at: Date;
  analysis_version: string;
}

export interface MetricVolatility {
  score: number;
  mean: number;
  std_dev: number;
  classification: string;
  reason?: string;
}

export interface RecoveryEvent {
  metric: string;
  drop_magnitude: number;
  recovery_magnitude: number;
  recovery_days: number;
}

// ============================================
// Alert Types
// ============================================

export interface RelationshipAlert {
  id: string;
  relationship_id: string;
  event_id: string | null;
  alert_type: string;
  severity: 'INFO' | 'WARNING' | 'CRITICAL';
  title: string;
  description: string;
  visibility: 'BOTH_PARTIES' | 'FOUNDER_ONLY' | 'INVESTOR_ONLY';
  status: 'ACTIVE' | 'ACKNOWLEDGED' | 'RESOLVED';
  created_at: Date;
  acknowledged_at: Date | null;
  resolved_at: Date | null;
}

// ============================================
// Temporal Signal Types
// ============================================

export interface TemporalSignals {
  entropy: number | null;
  stability: number | null;
  decay_rate: number;
  recovery_capacity: number;
}

// ============================================
// Validation Types
// ============================================

export interface ValidationError {
  field: string;
  error: string;
  message: string;
  severity?: 'ERROR' | 'WARNING' | 'INFO';
}

export interface ValidationResult {
  is_valid: boolean;
  errors: ValidationError[];
  warnings: ValidationError[];
}

// ============================================
// Pipeline Types
// ============================================

export type SnapshotStatus = 'PROCESSING' | 'PROCESSED' | 'FAILED';

export interface PipelineResult {
  snapshot_id: string;
  status: SnapshotStatus;
  integrity_score?: IntegrityScore;
  temporal_pattern?: TemporalPattern;
  events_emitted: string[];
  error?: string;
}

// ============================================
// Relationship Type Registry
// ============================================

export const RELATIONSHIP_TYPES: Record<string, RelationshipType> = {
  INVESTMENT: {
    type: 'INVESTMENT',
    label: 'Investment',
    roles: { a: 'INVESTOR', b: 'COMPANY' },
    requiredFields: ['investment_amount', 'investment_date', 'equity_percentage'],
    snapshotSchema: {
      revenue: { type: 'number', required: true, description: 'Current revenue' },
      burn_rate: { type: 'number', required: true, description: 'Monthly burn rate' },
      runway_months: { type: 'number', required: true, description: 'Months of runway remaining' },
      headcount: { type: 'number', required: false, description: 'Current team size' },
      milestones_hit: { type: 'object', required: false, description: 'Milestone completion status' },
    },
  },

  PARTNERSHIP: {
    type: 'PARTNERSHIP',
    label: 'Partnership',
    roles: { a: 'PARTNER_A', b: 'PARTNER_B' },
    requiredFields: ['partnership_type', 'start_date'],
    snapshotSchema: {
      joint_revenue: { type: 'number', required: true, description: 'Revenue from partnership' },
      shared_costs: { type: 'number', required: false, description: 'Shared operational costs' },
      deliverables_status: { type: 'object', required: true, description: 'Status of agreed deliverables' },
    },
  },

  DISTRIBUTION: {
    type: 'DISTRIBUTION',
    label: 'Distribution',
    roles: { a: 'SUPPLIER', b: 'DISTRIBUTOR' },
    requiredFields: ['territory', 'product_category'],
    snapshotSchema: {
      units_sold: { type: 'number', required: true, description: 'Units sold in period' },
      revenue_share: { type: 'number', required: true, description: 'Revenue share amount' },
      territory_coverage: { type: 'number', required: false, description: 'Coverage percentage' },
      inventory_levels: { type: 'number', required: false, description: 'Current inventory' },
    },
  },

  ADVISORY: {
    type: 'ADVISORY',
    label: 'Advisory',
    roles: { a: 'ADVISOR', b: 'ADVISEE' },
    requiredFields: ['advisory_scope', 'compensation_type'],
    snapshotSchema: {
      hours_contributed: { type: 'number', required: true, description: 'Advisory hours this period' },
      introductions_made: { type: 'number', required: false, description: 'Introductions facilitated' },
      milestones_advised: { type: 'object', required: false, description: 'Milestones with advisory input' },
    },
  },

  VENDOR: {
    type: 'VENDOR',
    label: 'Vendor',
    roles: { a: 'CLIENT', b: 'VENDOR' },
    requiredFields: ['contract_value', 'service_type'],
    snapshotSchema: {
      spend_to_date: { type: 'number', required: true, description: 'Total spend to date' },
      deliverables_completed: { type: 'number', required: true, description: 'Deliverables completed' },
      satisfaction_score: { type: 'number', required: false, description: 'Client satisfaction (1-10)' },
    },
  },
};

// ============================================
// Validation Functions
// ============================================

export function validateRelationshipType(type: string): boolean {
  return type in RELATIONSHIP_TYPES;
}

export function getRelationshipType(type: string): RelationshipType {
  const relType = RELATIONSHIP_TYPES[type];
  if (!relType) {
    throw new Error(`Unknown relationship type: ${type}`);
  }
  return relType;
}

export function validateSnapshotData(
  type: string,
  data: Record<string, unknown>
): string[] {
  const relType = getRelationshipType(type);
  const errors: string[] = [];

  for (const [field, def] of Object.entries(relType.snapshotSchema)) {
    if (def.required && !(field in data)) {
      errors.push(`Missing required field: ${field}`);
    }
    if (field in data && def.type === 'number' && typeof data[field] !== 'number') {
      errors.push(`Field ${field} must be a number`);
    }
  }

  return errors;
}

export function getRolesForType(type: string): { a: string; b: string } {
  return getRelationshipType(type).roles;
}
