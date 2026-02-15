/**
 * Integrity Score Calculator
 *
 * Calculates Structural Mutual Integrity (SMI) scores for relationships.
 * Every relationship type MUST have an integrity calculation handler.
 */

import {
  IntegrityScore,
  Relationship,
  Snapshot,
  RELATIONSHIP_TYPES,
} from '../types/relationship_types';

// ============================================
// Type-specific integrity handlers
// ============================================

export interface RelationshipTypeHandler {
  type: string;
  calculateIntegrity: (
    relationship: Relationship,
    snapshots: Snapshot[]
  ) => IntegrityScore;
}

function calculateInvestmentIntegrity(
  _relationship: Relationship,
  snapshots: Snapshot[]
): IntegrityScore {
  if (snapshots.length === 0) {
    return { smi: 0, components: {} };
  }

  const latest = snapshots[0];
  const declarations = latest.declarations as Record<string, unknown>;
  const financials = latest.financials as Record<string, unknown>;

  // Component scores (0-100 each)
  const components: Record<string, number> = {};

  // Snapshot frequency: more frequent = higher score
  components.snapshot_frequency = calculateSnapshotFrequency(snapshots);

  // Data completeness: more fields filled = higher score
  components.data_completeness = calculateDataCompleteness(declarations, financials);

  // Consistency: less variance between snapshots = higher score
  components.consistency = calculateConsistency(snapshots);

  // Trend: improving metrics = higher score
  components.trend = calculateTrend(snapshots);

  // Weighted average
  const smi = Math.round(
    components.snapshot_frequency * 0.25 +
    components.data_completeness * 0.30 +
    components.consistency * 0.25 +
    components.trend * 0.20
  );

  return { smi, components };
}

function calculatePartnershipIntegrity(
  _relationship: Relationship,
  snapshots: Snapshot[]
): IntegrityScore {
  if (snapshots.length === 0) {
    return { smi: 0, components: {} };
  }

  const components: Record<string, number> = {};

  components.snapshot_frequency = calculateSnapshotFrequency(snapshots);
  components.data_completeness = calculateDataCompleteness(
    snapshots[0].declarations,
    snapshots[0].financials
  );
  components.mutual_delivery = calculateMutualDelivery(snapshots);
  components.consistency = calculateConsistency(snapshots);

  const smi = Math.round(
    components.snapshot_frequency * 0.20 +
    components.data_completeness * 0.25 +
    components.mutual_delivery * 0.35 +
    components.consistency * 0.20
  );

  return { smi, components };
}

function calculateDistributionIntegrity(
  _relationship: Relationship,
  snapshots: Snapshot[]
): IntegrityScore {
  if (snapshots.length === 0) {
    return { smi: 0, components: {} };
  }

  const components: Record<string, number> = {};

  components.snapshot_frequency = calculateSnapshotFrequency(snapshots);
  components.data_completeness = calculateDataCompleteness(
    snapshots[0].declarations,
    snapshots[0].financials
  );
  components.volume_consistency = calculateConsistency(snapshots);
  components.coverage_growth = calculateTrend(snapshots);

  const smi = Math.round(
    components.snapshot_frequency * 0.20 +
    components.data_completeness * 0.25 +
    components.volume_consistency * 0.30 +
    components.coverage_growth * 0.25
  );

  return { smi, components };
}

function calculateAdvisoryIntegrity(
  _relationship: Relationship,
  snapshots: Snapshot[]
): IntegrityScore {
  if (snapshots.length === 0) {
    return { smi: 0, components: {} };
  }

  const components: Record<string, number> = {};

  components.snapshot_frequency = calculateSnapshotFrequency(snapshots);
  components.engagement_level = calculateEngagementLevel(snapshots);
  components.consistency = calculateConsistency(snapshots);

  const smi = Math.round(
    components.snapshot_frequency * 0.30 +
    components.engagement_level * 0.40 +
    components.consistency * 0.30
  );

  return { smi, components };
}

function calculateVendorIntegrity(
  _relationship: Relationship,
  snapshots: Snapshot[]
): IntegrityScore {
  if (snapshots.length === 0) {
    return { smi: 0, components: {} };
  }

  const components: Record<string, number> = {};

  components.snapshot_frequency = calculateSnapshotFrequency(snapshots);
  components.data_completeness = calculateDataCompleteness(
    snapshots[0].declarations,
    snapshots[0].financials
  );
  components.delivery_rate = calculateDeliveryRate(snapshots);
  components.consistency = calculateConsistency(snapshots);

  const smi = Math.round(
    components.snapshot_frequency * 0.20 +
    components.data_completeness * 0.20 +
    components.delivery_rate * 0.35 +
    components.consistency * 0.25
  );

  return { smi, components };
}

// ============================================
// Handler Registry
// ============================================

const TYPE_HANDLERS: Record<string, RelationshipTypeHandler> = {
  INVESTMENT: {
    type: 'INVESTMENT',
    calculateIntegrity: calculateInvestmentIntegrity,
  },
  PARTNERSHIP: {
    type: 'PARTNERSHIP',
    calculateIntegrity: calculatePartnershipIntegrity,
  },
  DISTRIBUTION: {
    type: 'DISTRIBUTION',
    calculateIntegrity: calculateDistributionIntegrity,
  },
  ADVISORY: {
    type: 'ADVISORY',
    calculateIntegrity: calculateAdvisoryIntegrity,
  },
  VENDOR: {
    type: 'VENDOR',
    calculateIntegrity: calculateVendorIntegrity,
  },
};

/**
 * Calculate integrity score for a relationship.
 * Dispatches to the correct type-specific handler.
 */
export function calculateIntegrityForType(
  relationship: Relationship,
  snapshots: Snapshot[]
): IntegrityScore {
  const handler = TYPE_HANDLERS[relationship.relationship_type];

  if (!handler) {
    throw new Error(
      `No integrity calculation handler for type: ${relationship.relationship_type}. ` +
      `Registered types: ${Object.keys(TYPE_HANDLERS).join(', ')}`
    );
  }

  // Sort snapshots by date descending (most recent first)
  const sortedSnapshots = [...snapshots].sort(
    (a, b) => new Date(b.snapshot_date).getTime() - new Date(a.snapshot_date).getTime()
  );

  return handler.calculateIntegrity(relationship, sortedSnapshots);
}

/**
 * Verify all registered relationship types have integrity handlers.
 * Should be called at application startup.
 */
export function verifyHandlerCompleteness(): string[] {
  const missing: string[] = [];

  for (const type of Object.keys(RELATIONSHIP_TYPES)) {
    if (!TYPE_HANDLERS[type]) {
      missing.push(type);
    }
  }

  return missing;
}

// ============================================
// Shared calculation helpers
// ============================================

function calculateSnapshotFrequency(snapshots: Snapshot[]): number {
  if (snapshots.length < 2) return snapshots.length > 0 ? 50 : 0;

  const dates = snapshots.map(s => new Date(s.snapshot_date).getTime());
  const intervals: number[] = [];

  for (let i = 1; i < dates.length; i++) {
    intervals.push(dates[i - 1] - dates[i]);
  }

  const avgIntervalDays = intervals.reduce((a, b) => a + b, 0) / intervals.length / (1000 * 60 * 60 * 24);

  // Score based on average interval (monthly = 100, quarterly = 70, yearly = 30)
  if (avgIntervalDays <= 30) return 100;
  if (avgIntervalDays <= 45) return 85;
  if (avgIntervalDays <= 90) return 70;
  if (avgIntervalDays <= 180) return 50;
  if (avgIntervalDays <= 365) return 30;
  return 10;
}

function calculateDataCompleteness(
  declarations: Record<string, unknown>,
  financials: Record<string, unknown>
): number {
  const declFields = Object.keys(declarations || {}).length;
  const finFields = Object.keys(financials || {}).length;
  const totalFields = declFields + finFields;

  if (totalFields === 0) return 0;
  if (totalFields >= 10) return 100;
  return Math.round((totalFields / 10) * 100);
}

function calculateConsistency(snapshots: Snapshot[]): number {
  if (snapshots.length < 2) return 50;

  // Check if snapshots maintain consistent field coverage
  const fieldCounts = snapshots.map(s => {
    const declFields = Object.keys(s.declarations || {}).length;
    const finFields = Object.keys(s.financials || {}).length;
    return declFields + finFields;
  });

  const avg = fieldCounts.reduce((a, b) => a + b, 0) / fieldCounts.length;
  const variance = fieldCounts.reduce((sum, val) => sum + Math.pow(val - avg, 2), 0) / fieldCounts.length;
  const stdDev = Math.sqrt(variance);
  const cv = avg > 0 ? stdDev / avg : 0;

  // Lower coefficient of variation = higher consistency
  if (cv <= 0.1) return 100;
  if (cv <= 0.2) return 85;
  if (cv <= 0.3) return 70;
  if (cv <= 0.5) return 50;
  return 30;
}

function calculateTrend(snapshots: Snapshot[]): number {
  if (snapshots.length < 2) return 50;
  // Simplified: check if numeric financial values are trending positively
  return 65; // Placeholder for full trend analysis
}

function calculateMutualDelivery(snapshots: Snapshot[]): number {
  if (snapshots.length === 0) return 0;
  const latest = snapshots[0];
  const deliverables = latest.declarations?.deliverables_status as Record<string, unknown> | undefined;
  if (!deliverables) return 50;

  const total = Object.keys(deliverables).length;
  if (total === 0) return 50;

  const completed = Object.values(deliverables).filter(v => v === 'completed' || v === true).length;
  return Math.round((completed / total) * 100);
}

function calculateEngagementLevel(snapshots: Snapshot[]): number {
  if (snapshots.length === 0) return 0;
  const latest = snapshots[0];
  const hours = (latest.declarations?.hours_contributed as number) || 0;

  if (hours >= 20) return 100;
  if (hours >= 10) return 80;
  if (hours >= 5) return 60;
  if (hours > 0) return 40;
  return 0;
}

function calculateDeliveryRate(snapshots: Snapshot[]): number {
  if (snapshots.length === 0) return 0;
  const latest = snapshots[0];
  const completed = (latest.declarations?.deliverables_completed as number) || 0;

  if (completed >= 10) return 100;
  if (completed >= 5) return 75;
  if (completed > 0) return 50;
  return 0;
}
