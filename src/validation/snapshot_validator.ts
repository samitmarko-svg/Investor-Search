/**
 * Snapshot Validator
 *
 * Multi-layer validation for snapshot submissions.
 * Validates schema, plausibility, temporal consistency, and cross-field logic.
 */

import { Pool } from 'pg';
import {
  ValidationResult,
  ValidationError,
  Snapshot,
} from '../types/relationship_types';

export class SnapshotValidator {
  /**
   * Full validation pipeline.
   * Returns structured validation result with errors and warnings.
   */
  async validate(
    data: Record<string, unknown>,
    relationshipId: string,
    relationshipType: string,
    db: Pool
  ): Promise<ValidationResult> {
    const errors: ValidationError[] = [];
    const warnings: ValidationError[] = [];

    // Layer 1: Schema validation
    const schemaErrors = this.validateSchema(data, relationshipType);
    errors.push(...schemaErrors.filter((e) => e.severity !== 'WARNING'));
    warnings.push(...schemaErrors.filter((e) => e.severity === 'WARNING'));

    // Layer 2: Plausibility bounds
    const plausibilityResults = this.validatePlausibility(data);
    errors.push(...plausibilityResults.filter((e) => e.severity !== 'WARNING'));
    warnings.push(...plausibilityResults.filter((e) => e.severity === 'WARNING'));

    // Layer 3: Temporal consistency (needs DB access)
    const temporalResults = await this.validateTemporal(data, relationshipId, db);
    warnings.push(...temporalResults);

    // Layer 4: Cross-field consistency
    const consistencyResults = this.validateConsistency(data);
    warnings.push(...consistencyResults);

    return {
      is_valid: errors.length === 0,
      errors,
      warnings,
    };
  }

  // ============================================
  // Layer 1: Schema Validation
  // ============================================

  private validateSchema(
    data: Record<string, unknown>,
    _relationshipType: string
  ): ValidationError[] {
    const errors: ValidationError[] = [];

    // Check that snapshot_date is present and valid
    if (!data.snapshot_date) {
      errors.push({
        field: 'snapshot_date',
        error: 'REQUIRED_FIELD_MISSING',
        message: 'snapshot_date is required',
      });
    } else {
      const date = new Date(data.snapshot_date as string);
      if (isNaN(date.getTime())) {
        errors.push({
          field: 'snapshot_date',
          error: 'INVALID_DATE',
          message: 'snapshot_date must be a valid date',
        });
      }
    }

    // Check declarations and financials are objects
    if (data.declarations && typeof data.declarations !== 'object') {
      errors.push({
        field: 'declarations',
        error: 'INVALID_TYPE',
        message: 'declarations must be an object',
      });
    }

    if (data.financials && typeof data.financials !== 'object') {
      errors.push({
        field: 'financials',
        error: 'INVALID_TYPE',
        message: 'financials must be an object',
      });
    }

    // Validate numeric fields in financials
    const financials = (data.financials as Record<string, unknown>) || {};
    const numericFields = [
      'revenue',
      'burn_rate',
      'runway_months',
      'headcount',
      'joint_revenue',
      'units_sold',
      'revenue_share',
      'hours_contributed',
      'spend_to_date',
      'deliverables_completed',
    ];

    for (const field of numericFields) {
      if (field in financials && typeof financials[field] !== 'number') {
        errors.push({
          field,
          error: 'INVALID_TYPE',
          message: `${field} must be a number`,
        });
      }
    }

    return errors;
  }

  // ============================================
  // Layer 2: Plausibility Bounds
  // ============================================

  private validatePlausibility(
    data: Record<string, unknown>
  ): ValidationError[] {
    const errors: ValidationError[] = [];
    const financials = (data.financials as Record<string, unknown>) || {};
    const declarations = (data.declarations as Record<string, unknown>) || {};
    const allFields = { ...financials, ...declarations };

    // Revenue bounds
    if (typeof allFields.revenue === 'number') {
      if (allFields.revenue < 0) {
        errors.push({
          field: 'revenue',
          error: 'OUT_OF_BOUNDS',
          message: 'Revenue cannot be negative',
        });
      } else if (allFields.revenue > 100_000_000) {
        errors.push({
          field: 'revenue',
          error: 'SUSPICIOUSLY_HIGH',
          message: 'Revenue >$100M seems implausible for startup',
          severity: 'WARNING',
        });
      }
    }

    // Burn rate bounds
    if (typeof allFields.burn_rate === 'number') {
      if (allFields.burn_rate < 0) {
        errors.push({
          field: 'burn_rate',
          error: 'OUT_OF_BOUNDS',
          message: 'Burn rate cannot be negative',
        });
      }
    }

    // Headcount bounds
    if (typeof allFields.headcount === 'number') {
      if (allFields.headcount < 0) {
        errors.push({
          field: 'headcount',
          error: 'OUT_OF_BOUNDS',
          message: 'Headcount cannot be negative',
        });
      } else if (allFields.headcount > 1000) {
        errors.push({
          field: 'headcount',
          error: 'SUSPICIOUSLY_HIGH',
          message: 'Headcount >1000 seems implausible',
          severity: 'WARNING',
        });
      }
    }

    // Runway bounds (0 to 120 months)
    if (typeof allFields.runway_months === 'number') {
      if (allFields.runway_months < 0) {
        errors.push({
          field: 'runway_months',
          error: 'OUT_OF_BOUNDS',
          message: 'Runway cannot be negative',
        });
      } else if (allFields.runway_months > 120) {
        errors.push({
          field: 'runway_months',
          error: 'SUSPICIOUSLY_HIGH',
          message: 'Runway >10 years seems implausible',
          severity: 'WARNING',
        });
      }
    }

    // Satisfaction score bounds (1-10)
    if (typeof allFields.satisfaction_score === 'number') {
      if (allFields.satisfaction_score < 1 || allFields.satisfaction_score > 10) {
        errors.push({
          field: 'satisfaction_score',
          error: 'OUT_OF_BOUNDS',
          message: 'Satisfaction score must be between 1 and 10',
        });
      }
    }

    return errors;
  }

  // ============================================
  // Layer 3: Temporal Consistency
  // ============================================

  private async validateTemporal(
    data: Record<string, unknown>,
    relationshipId: string,
    db: Pool
  ): Promise<ValidationError[]> {
    const warnings: ValidationError[] = [];

    // Get previous snapshot
    const prevResult = await db.query(
      `SELECT * FROM snapshots
       WHERE relationship_id = $1 AND status = 'PROCESSED'
       ORDER BY snapshot_date DESC LIMIT 1`,
      [relationshipId]
    );

    if (prevResult.rows.length === 0) {
      return warnings; // First snapshot, nothing to compare
    }

    const previous = prevResult.rows[0] as Snapshot;
    const financials = (data.financials as Record<string, unknown>) || {};
    const prevFinancials = (previous.financials as Record<string, unknown>) || {};

    // Check for unrealistic revenue changes (>500% in one period)
    if (
      typeof financials.revenue === 'number' &&
      typeof prevFinancials.revenue === 'number' &&
      prevFinancials.revenue > 0
    ) {
      const changePct = Math.abs(
        ((financials.revenue as number) - (prevFinancials.revenue as number)) /
          (prevFinancials.revenue as number)
      );

      if (changePct > 5) {
        warnings.push({
          field: 'revenue',
          error: 'UNREALISTIC_CHANGE',
          message: `Revenue changed ${Math.round(changePct * 100)}% from previous snapshot`,
          severity: 'WARNING',
        });
      }
    }

    // Check for headcount jumps (>50% growth in one period)
    if (
      typeof financials.headcount === 'number' &&
      typeof prevFinancials.headcount === 'number' &&
      prevFinancials.headcount > 0
    ) {
      const growth =
        ((financials.headcount as number) - (prevFinancials.headcount as number)) /
        (prevFinancials.headcount as number);

      if (growth > 0.5) {
        warnings.push({
          field: 'headcount',
          error: 'UNREALISTIC_GROWTH',
          message: `Headcount grew ${Math.round(growth * 100)}% in one period`,
          severity: 'WARNING',
        });
      }
    }

    return warnings;
  }

  // ============================================
  // Layer 4: Cross-Field Consistency
  // ============================================

  private validateConsistency(
    data: Record<string, unknown>
  ): ValidationError[] {
    const warnings: ValidationError[] = [];
    const financials = (data.financials as Record<string, unknown>) || {};
    const declarations = (data.declarations as Record<string, unknown>) || {};
    const allFields = { ...financials, ...declarations };

    // Revenue vs burn_rate sanity check
    if (
      typeof allFields.revenue === 'number' &&
      typeof allFields.burn_rate === 'number'
    ) {
      const revenue = allFields.revenue as number;
      const burnRate = allFields.burn_rate as number;

      if (revenue > 10000 && burnRate > revenue * 5) {
        warnings.push({
          field: 'burn_rate',
          error: 'INCONSISTENT_WITH_REVENUE',
          message: 'Burn rate 5x revenue seems unsustainable',
          severity: 'WARNING',
        });
      }
    }

    // Headcount vs revenue sanity check
    if (
      typeof allFields.headcount === 'number' &&
      typeof allFields.revenue === 'number'
    ) {
      const headcount = allFields.headcount as number;
      const revenue = allFields.revenue as number;

      if (headcount > 0 && revenue > 0) {
        const revenuePerPerson = revenue / headcount;
        if (revenuePerPerson < 1000) {
          warnings.push({
            field: 'revenue',
            error: 'LOW_PRODUCTIVITY',
            message: `Revenue per team member: $${Math.round(revenuePerPerson)}/period`,
            severity: 'INFO',
          });
        }
      }
    }

    return warnings;
  }
}
