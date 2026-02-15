/**
 * Guardrail: CRM Drift Prevention
 *
 * Prevents the system from drifting into generic CRM territory.
 * All features must be relationship-centric.
 */

// Patterns that indicate CRM drift - block in code reviews
const FORBIDDEN_PATTERNS: RegExp[] = [
  /notes:\s*string/,           // Generic notes field
  /tasks:/,                    // Task management
  /calendar/i,                 // Calendar integration
  /email.*integration/i,       // Email integration
  /contact.*management/i,      // Generic contact management
];

/**
 * Lint source code for CRM drift patterns.
 * Use in CI/CD pipeline or pre-commit hooks.
 */
export function lintForCRMDrift(code: string): string[] {
  const violations: string[] = [];

  for (const pattern of FORBIDDEN_PATTERNS) {
    if (pattern.test(code)) {
      violations.push(`Forbidden CRM pattern detected: ${pattern.source}`);
    }
  }

  return violations;
}

// Marketplace keywords that should never appear in endpoints
const MARKETPLACE_KEYWORDS: string[] = [
  'recommend',
  'suggest',
  'match',
  'top_rated',
  'best_',
  'search_partners',
  'find_investors',
  'browse_',
];

/**
 * Prevent marketplace-style endpoints from being registered.
 * Apply as middleware or route registration guard.
 */
export function preventMarketplaceEndpoints(endpoint: string): void {
  for (const keyword of MARKETPLACE_KEYWORDS) {
    if (endpoint.includes(keyword)) {
      throw new Error(
        `Forbidden marketplace endpoint: ${endpoint}. ` +
        `This system is infrastructure, not a marketplace.`
      );
    }
  }
}

/**
 * Validate that a feature request is relationship-centric.
 * Returns validation errors if the feature violates guardrails.
 */
export function validateFeatureScope(featureDescription: string): string[] {
  const errors: string[] = [];
  const lower = featureDescription.toLowerCase();

  if (lower.includes('general note') || lower.includes('free-form note')) {
    errors.push('Generic notes are forbidden. Notes must be attached to snapshots.');
  }

  if (lower.includes('task management') || lower.includes('todo list')) {
    errors.push('Task management is forbidden. Use conversation triggers instead.');
  }

  if (lower.includes('partner recommendation') || lower.includes('suggest partner')) {
    errors.push('Partner recommendations are forbidden. Show data, let users decide.');
  }

  if (lower.includes('ranking') || lower.includes('leaderboard')) {
    errors.push('Entity rankings are forbidden. Show aggregate statistics without rankings.');
  }

  return errors;
}
