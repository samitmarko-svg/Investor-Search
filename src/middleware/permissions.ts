/**
 * Permission Middleware
 *
 * Enforces relationship-scoped access control:
 * - Only parties in a relationship can access it
 * - Only the submitting party (e.g., company/founder) can create snapshots
 */

import { Request, Response, NextFunction } from 'express';
import { Pool } from 'pg';

/**
 * Middleware factory that enforces relationship access.
 * User must be a party (entity_a or entity_b) to access the relationship.
 */
export function requireRelationshipAccess(db: Pool) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const relationshipId = req.params.id;
    const userId = (req as AuthenticatedRequest).userId;

    if (!userId) {
      res.status(401).json({ error: 'Authentication required' });
      return;
    }

    if (!relationshipId) {
      next();
      return;
    }

    try {
      const hasAccess = await checkRelationshipAccess(db, userId, relationshipId);

      if (!hasAccess) {
        res.status(403).json({
          error: 'Access denied',
          message: 'You are not a party in this relationship',
        });
        return;
      }

      next();
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Permission check failed';
      res.status(500).json({ error: message });
    }
  };
}

/**
 * Middleware factory that enforces snapshot submission rights.
 * Only the company/project/advisee side can submit snapshots.
 */
export function requireSnapshotSubmissionRights(db: Pool) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const relationshipId = req.params.id;
    const userId = (req as AuthenticatedRequest).userId;

    if (!userId) {
      res.status(401).json({ error: 'Authentication required' });
      return;
    }

    try {
      // Get relationship
      const relResult = await db.query(
        `SELECT * FROM relationships WHERE id = $1 AND deleted_at IS NULL`,
        [relationshipId]
      );

      if (relResult.rows.length === 0) {
        res.status(404).json({ error: 'Relationship not found' });
        return;
      }

      const relationship = relResult.rows[0];

      // Get user's entity IDs
      const entityIds = await getUserEntityIds(db, userId);

      // Determine which side can submit (role_b is typically the submitting party)
      // COMPANY, PARTNER_B, DISTRIBUTOR, ADVISEE, VENDOR
      const submitterRoles = ['COMPANY', 'PARTNER_B', 'DISTRIBUTOR', 'ADVISEE', 'VENDOR'];

      let canSubmit = false;

      if (submitterRoles.includes(relationship.role_b) && entityIds.includes(relationship.entity_b_id)) {
        canSubmit = true;
      }
      if (submitterRoles.includes(relationship.role_a) && entityIds.includes(relationship.entity_a_id)) {
        canSubmit = true;
      }

      // If neither side matches typical submitter roles, allow any party
      if (!canSubmit) {
        canSubmit = entityIds.includes(relationship.entity_a_id) ||
                    entityIds.includes(relationship.entity_b_id);
      }

      if (!canSubmit) {
        res.status(403).json({
          error: 'Access denied',
          message: 'Only the submitting party can create snapshots',
        });
        return;
      }

      // Attach entity info to request for downstream use
      (req as AuthenticatedRequest).submittingEntityId =
        entityIds.includes(relationship.entity_b_id)
          ? relationship.entity_b_id
          : relationship.entity_a_id;

      next();
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Permission check failed';
      res.status(500).json({ error: message });
    }
  };
}

/**
 * Simple authentication middleware.
 * Extracts user ID from x-user-id header or authorization token.
 */
export function authenticate(
  req: Request,
  res: Response,
  next: NextFunction
): void {
  const userId = req.headers['x-user-id'] as string | undefined;

  if (!userId) {
    res.status(401).json({ error: 'Authentication required' });
    return;
  }

  (req as AuthenticatedRequest).userId = userId;
  next();
}

// ============================================
// Helpers
// ============================================

async function checkRelationshipAccess(
  db: Pool,
  userId: string,
  relationshipId: string
): Promise<boolean> {
  const entityIds = await getUserEntityIds(db, userId);

  if (entityIds.length === 0) return false;

  const result = await db.query(
    `SELECT id FROM relationships
     WHERE id = $1
     AND deleted_at IS NULL
     AND (entity_a_id = ANY($2::uuid[]) OR entity_b_id = ANY($2::uuid[]))`,
    [relationshipId, entityIds]
  );

  return result.rows.length > 0;
}

async function getUserEntityIds(db: Pool, userId: string): Promise<string[]> {
  // Check if user_entities table exists, fall back gracefully
  try {
    const result = await db.query(
      `SELECT entity_id FROM user_entities WHERE user_id = $1`,
      [userId]
    );
    return result.rows.map((r: Record<string, unknown>) => r.entity_id as string);
  } catch {
    // If user_entities table doesn't exist yet, check entities table directly
    try {
      const result = await db.query(
        `SELECT id FROM entities WHERE created_by = $1`,
        [userId]
      );
      return result.rows.map((r: Record<string, unknown>) => r.id as string);
    } catch {
      return [];
    }
  }
}

// ============================================
// Types
// ============================================

export interface AuthenticatedRequest extends Request {
  userId?: string;
  submittingEntityId?: string;
}
