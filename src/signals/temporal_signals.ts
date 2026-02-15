/**
 * Temporal Signal Converter
 *
 * Converts TemporalPattern data into quantified signals:
 * - entropy (behavioral unpredictability, 0-1)
 * - stability (inverse of entropy, 0-1)
 * - decay_rate (trust erosion speed per day)
 * - recovery_capacity (ability to recover from setbacks, 0-1)
 */

import { TemporalPattern, TemporalSignals } from '../types/relationship_types';

export class TemporalSignalConverter {
  /**
   * Convert a TemporalPattern to quantified signals.
   */
  convert(pattern: TemporalPattern | null): TemporalSignals {
    if (!pattern) {
      return {
        entropy: null,
        stability: null,
        decay_rate: 0.01,
        recovery_capacity: 0.5,
      };
    }

    const entropy = this.calculateEntropy(pattern);
    const stability = entropy !== null ? Math.round((1 - entropy) * 10000) / 10000 : null;

    return {
      entropy,
      stability,
      decay_rate: this.calculateDecayRate(pattern),
      recovery_capacity: this.calculateRecoveryCapacity(pattern),
    };
  }

  /**
   * Behavioral entropy (unpredictability).
   * Higher = more chaotic. 0-1 scale.
   */
  private calculateEntropy(pattern: TemporalPattern): number | null {
    const volatilityScore = pattern.volatility_score ?? 0;

    // Cadence contribution
    const cadenceMap: Record<string, number> = {
      HIGH: 0,
      MODERATE: 0.3,
      LOW: 0.6,
    };
    const cadenceScore = pattern.cadence_regularity
      ? cadenceMap[pattern.cadence_regularity] ?? 0.3
      : 0.3;

    // Weighted aggregate (0-1 scale)
    const entropy = volatilityScore * 0.7 + cadenceScore * 0.3;

    return Math.round(Math.min(1, Math.max(0, entropy)) * 10000) / 10000;
  }

  /**
   * Trust decay rate (how fast trust erodes without updates).
   * Based on trajectory direction.
   */
  private calculateDecayRate(pattern: TemporalPattern): number {
    if (!pattern.trajectory_direction) {
      return 0.01; // Default slow decay
    }

    const decayMap: Record<string, number> = {
      GROWTH: 0.005,   // Slow decay (improving relationship)
      STABLE: 0.01,    // Normal decay
      DECLINE: 0.03,   // Fast decay (declining relationship)
      VOLATILE: 0.05,  // Very fast decay (unstable)
    };

    return decayMap[pattern.trajectory_direction] ?? 0.01;
  }

  /**
   * Ability to recover from setbacks.
   * Based on historical recovery events.
   */
  private calculateRecoveryCapacity(pattern: TemporalPattern): number {
    if (!pattern.recovery_detected) {
      return 0.5; // Neutral (no evidence)
    }

    const speedDays = pattern.recovery_speed_days;
    if (speedDays === null) return 0.5;

    if (speedDays < 30) return 0.9;
    if (speedDays < 60) return 0.7;
    if (speedDays < 90) return 0.5;
    return 0.3;
  }
}
