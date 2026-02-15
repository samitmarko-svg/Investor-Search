/**
 * API v2: Relationships Endpoints
 *
 * Relationship-scoped endpoints for managing relationships, snapshots,
 * and integrity scores.
 */

import { Router, Request, Response } from 'express';
import { Pool } from 'pg';
import {
  validateRelationshipType,
  getRelationshipType,
  validateSnapshotData,
} from '../../src/types/relationship_types';
import { activateRelationship, createSnapshot } from '../../src/guardrails/snapshot_first';
import { preventMarketplaceEndpoints } from '../../src/guardrails/crm_drift';
import { calculateIntegrityForType } from '../../src/integrity/calculator';

export function createRelationshipRouter(db: Pool): Router {
  const router = Router();

  // Guardrail middleware: prevent marketplace endpoints
  router.use((req, _res, next) => {
    try {
      preventMarketplaceEndpoints(req.path);
      next();
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Forbidden endpoint';
      _res.status(400).json({ error: message });
    }
  });

  // ============================================
  // POST /api/v2/relationships
  // Create a new relationship
  // ============================================
  router.post('/', async (req: Request, res: Response) => {
    try {
      const { entity_a_id, entity_b_id, relationship_type, metadata } = req.body;

      // Validate required fields
      if (!entity_a_id || !entity_b_id || !relationship_type) {
        return res.status(400).json({
          error: 'Missing required fields: entity_a_id, entity_b_id, relationship_type',
        });
      }

      // Validate relationship type
      if (!validateRelationshipType(relationship_type)) {
        return res.status(400).json({
          error: `Invalid relationship type: ${relationship_type}`,
        });
      }

      // Prevent self-relationships
      if (entity_a_id === entity_b_id) {
        return res.status(400).json({
          error: 'Cannot create relationship between an entity and itself',
        });
      }

      // Get roles for this type
      const relType = getRelationshipType(relationship_type);

      // Check for duplicate
      const existing = await db.query(
        `SELECT id FROM relationships
         WHERE entity_a_id = $1 AND entity_b_id = $2
           AND relationship_type = $3
           AND deleted_at IS NULL AND status != 'TERMINATED'`,
        [entity_a_id, entity_b_id, relationship_type]
      );

      if (existing.rows.length > 0) {
        return res.status(409).json({
          error: 'Active relationship already exists between these entities',
          existing_id: existing.rows[0].id,
        });
      }

      // Create relationship (status = PENDING until first snapshot)
      const result = await db.query(
        `INSERT INTO relationships (
           entity_a_id, entity_b_id, role_a, role_b,
           relationship_type, status, metadata
         ) VALUES ($1, $2, $3, $4, $5, 'PENDING', $6)
         RETURNING *`,
        [entity_a_id, entity_b_id, relType.roles.a, relType.roles.b, relationship_type, JSON.stringify(metadata || {})]
      );

      return res.status(201).json(result.rows[0]);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Internal server error';
      return res.status(500).json({ error: message });
    }
  });

  // ============================================
  // GET /api/v2/relationships/:id
  // Get a relationship by ID
  // ============================================
  router.get('/:id', async (req: Request, res: Response) => {
    try {
      const result = await db.query(
        `SELECT r.*,
           ea.name as entity_a_name,
           eb.name as entity_b_name,
           (SELECT smi FROM integrity_scores
            WHERE relationship_id = r.id
            ORDER BY calculated_at DESC LIMIT 1) as latest_integrity
         FROM relationships r
         LEFT JOIN entities ea ON ea.id = r.entity_a_id
         LEFT JOIN entities eb ON eb.id = r.entity_b_id
         WHERE r.id = $1 AND r.deleted_at IS NULL`,
        [req.params.id]
      );

      if (result.rows.length === 0) {
        return res.status(404).json({ error: 'Relationship not found' });
      }

      return res.json(result.rows[0]);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Internal server error';
      return res.status(500).json({ error: message });
    }
  });

  // ============================================
  // PATCH /api/v2/relationships/:id
  // Update relationship status
  // ============================================
  router.patch('/:id', async (req: Request, res: Response) => {
    try {
      const { status, metadata } = req.body;

      if (status === 'ACTIVE') {
        // Enforces snapshot-first rule
        await activateRelationship(db, req.params.id);
        return res.json({ message: 'Relationship activated' });
      }

      if (status === 'TERMINATED') {
        await db.query(
          `UPDATE relationships
           SET status = 'TERMINATED', terminated_at = NOW()
           WHERE id = $1 AND deleted_at IS NULL`,
          [req.params.id]
        );
        return res.json({ message: 'Relationship terminated' });
      }

      if (metadata) {
        await db.query(
          `UPDATE relationships SET metadata = $1 WHERE id = $2 AND deleted_at IS NULL`,
          [JSON.stringify(metadata), req.params.id]
        );
        return res.json({ message: 'Relationship updated' });
      }

      return res.status(400).json({ error: 'No valid update fields provided' });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Internal server error';
      return res.status(500).json({ error: message });
    }
  });

  // ============================================
  // POST /api/v2/relationships/:id/snapshots
  // Submit a snapshot for a relationship
  // ============================================
  router.post('/:id/snapshots', async (req: Request, res: Response) => {
    try {
      const { snapshot_date, declarations, financials, context_notes } = req.body;

      if (!snapshot_date || !declarations || !financials) {
        return res.status(400).json({
          error: 'Missing required fields: snapshot_date, declarations, financials',
        });
      }

      // Get relationship to validate type-specific data
      const relResult = await db.query(
        'SELECT * FROM relationships WHERE id = $1 AND deleted_at IS NULL',
        [req.params.id]
      );

      if (relResult.rows.length === 0) {
        return res.status(404).json({ error: 'Relationship not found' });
      }

      const relationship = relResult.rows[0];

      // Validate snapshot data against type schema
      const validationErrors = validateSnapshotData(relationship.relationship_type, {
        ...declarations,
        ...financials,
      });

      if (validationErrors.length > 0) {
        return res.status(400).json({
          error: 'Snapshot data validation failed',
          details: validationErrors,
        });
      }

      // Create snapshot (integrity score calculated automatically)
      const snapshot = await createSnapshot(db, req.params.id, {
        snapshot_date: new Date(snapshot_date),
        declarations,
        financials,
        context_notes,
      });

      return res.status(201).json(snapshot);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Internal server error';
      return res.status(500).json({ error: message });
    }
  });

  // ============================================
  // GET /api/v2/relationships/:id/integrity
  // Get integrity score for a relationship
  // ============================================
  router.get('/:id/integrity', async (req: Request, res: Response) => {
    try {
      const result = await db.query(
        `SELECT * FROM integrity_scores
         WHERE relationship_id = $1
         ORDER BY calculated_at DESC
         LIMIT 10`,
        [req.params.id]
      );

      return res.json({
        relationship_id: req.params.id,
        scores: result.rows,
        latest: result.rows[0] || null,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Internal server error';
      return res.status(500).json({ error: message });
    }
  });

  // ============================================
  // GET /api/v2/entities/:entityId/reputation
  // Get entity reputation by role (relationship-contextual)
  // ============================================
  router.get('/entities/:entityId/reputation', async (req: Request, res: Response) => {
    try {
      const entityId = req.params.entityId;

      const relationships = await db.query(
        `SELECT
           r.*,
           CASE
             WHEN r.entity_a_id = $1 THEN r.role_a
             WHEN r.entity_b_id = $1 THEN r.role_b
           END as entity_role,
           i.smi as latest_integrity
         FROM relationships r
         LEFT JOIN LATERAL (
           SELECT smi
           FROM integrity_scores
           WHERE relationship_id = r.id
           ORDER BY calculated_at DESC
           LIMIT 1
         ) i ON true
         WHERE (r.entity_a_id = $1 OR r.entity_b_id = $1)
           AND r.deleted_at IS NULL
           AND r.status = 'ACTIVE'`,
        [entityId]
      );

      // Group by role
      const byRole: Record<string, {
        relationship_count: number;
        integrity_scores: number[];
        average_integrity: number | null;
        relationships: unknown[];
      }> = {};

      for (const rel of relationships.rows) {
        const role = rel.entity_role;

        if (!byRole[role]) {
          byRole[role] = {
            relationship_count: 0,
            integrity_scores: [],
            average_integrity: null,
            relationships: [],
          };
        }

        byRole[role].relationship_count++;
        if (rel.latest_integrity != null) {
          byRole[role].integrity_scores.push(rel.latest_integrity);
        }
        byRole[role].relationships.push(rel);
      }

      // Calculate averages
      for (const role in byRole) {
        const scores = byRole[role].integrity_scores;
        byRole[role].average_integrity =
          scores.length > 0
            ? Math.round(scores.reduce((a, b) => a + b, 0) / scores.length)
            : null;
      }

      return res.json({
        entity_id: entityId,
        reputation_by_role: byRole,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Internal server error';
      return res.status(500).json({ error: message });
    }
  });

  return router;
}
