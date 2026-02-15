/**
 * API v2: Relationships Endpoints
 *
 * Relationship-scoped endpoints for managing relationships, snapshots,
 * and integrity scores. Now with async pipeline, validation, permissions,
 * and event propagation.
 */

import { Router, Request, Response } from 'express';
import { Pool } from 'pg';
import {
  validateRelationshipType,
  getRelationshipType,
  validateSnapshotData,
} from '../../src/types/relationship_types';
import { activateRelationship } from '../../src/guardrails/snapshot_first';
import { preventMarketplaceEndpoints } from '../../src/guardrails/crm_drift';
import { SnapshotPipeline, ValidationFailedError } from '../../src/pipeline/processor';
import { EventPropagator } from '../../src/events/propagation';
import {
  authenticate,
  requireRelationshipAccess,
  requireSnapshotSubmissionRights,
  AuthenticatedRequest,
} from '../../src/middleware/permissions';
import { createAuditMiddleware } from '../../src/middleware/audit';

export function createRelationshipRouter(db: Pool): Router {
  const router = Router();
  const pipeline = new SnapshotPipeline(db);
  const eventPropagator = new EventPropagator(db);

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

  // Audit logging for all data-modifying requests
  router.use(createAuditMiddleware(db));

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

      // Emit lifecycle event
      await eventPropagator.emitAndPropagate(
        result.rows[0].id,
        'intent_expressed',
        { entity_a_id, entity_b_id, relationship_type }
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

        await eventPropagator.emitAndPropagate(
          req.params.id,
          'relationship_activated',
          { activated_by: (req as AuthenticatedRequest).userId }
        );

        return res.json({ message: 'Relationship activated' });
      }

      if (status === 'TERMINATED') {
        await db.query(
          `UPDATE relationships
           SET status = 'TERMINATED', terminated_at = NOW()
           WHERE id = $1 AND deleted_at IS NULL`,
          [req.params.id]
        );

        await eventPropagator.emitAndPropagate(
          req.params.id,
          'state_transition',
          { from_state: 'ACTIVE', to_state: 'TERMINATED' },
          'CRITICAL'
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
  // Submit a snapshot for async processing (returns 202)
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

      // Submit to async pipeline
      const result = await pipeline.submit(
        req.params.id,
        {
          snapshot_date: new Date(snapshot_date),
          declarations,
          financials,
          context_notes,
        },
        (req as AuthenticatedRequest).submittingEntityId
      );

      return res.status(202).json({
        id: result.id,
        status: result.status,
        message: 'Snapshot queued for processing',
      });
    } catch (err) {
      if (err instanceof ValidationFailedError) {
        return res.status(400).json({
          error: 'Snapshot validation failed',
          details: err.errors,
        });
      }

      const message = err instanceof Error ? err.message : 'Internal server error';
      return res.status(500).json({ error: message });
    }
  });

  // ============================================
  // GET /api/v2/relationships/:id/snapshots/:snapshotId/status
  // Get snapshot processing status
  // ============================================
  router.get('/:id/snapshots/:snapshotId/status', async (req: Request, res: Response) => {
    try {
      const result = await db.query(
        `SELECT id, status, processed_at, error_message, created_at
         FROM snapshots
         WHERE id = $1 AND relationship_id = $2`,
        [req.params.snapshotId, req.params.id]
      );

      if (result.rows.length === 0) {
        return res.status(404).json({ error: 'Snapshot not found' });
      }

      return res.json(result.rows[0]);
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
  // GET /api/v2/relationships/:id/temporal
  // Get temporal patterns for a relationship
  // ============================================
  router.get('/:id/temporal', async (req: Request, res: Response) => {
    try {
      const result = await db.query(
        `SELECT * FROM temporal_patterns
         WHERE relationship_id = $1
         ORDER BY analyzed_at DESC
         LIMIT 10`,
        [req.params.id]
      );

      return res.json({
        relationship_id: req.params.id,
        patterns: result.rows,
        latest: result.rows[0] || null,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Internal server error';
      return res.status(500).json({ error: message });
    }
  });

  // ============================================
  // GET /api/v2/relationships/:id/events
  // Get events for a relationship
  // ============================================
  router.get('/:id/events', async (req: Request, res: Response) => {
    try {
      const limit = Math.min(parseInt(req.query.limit as string) || 50, 100);
      const severity = req.query.severity as string | undefined;

      let query = `SELECT * FROM relationship_events
                   WHERE relationship_id = $1`;
      const params: unknown[] = [req.params.id];

      if (severity) {
        query += ` AND severity = $2`;
        params.push(severity.toUpperCase());
      }

      query += ` ORDER BY occurred_at DESC LIMIT $${params.length + 1}`;
      params.push(limit);

      const result = await db.query(query, params);

      return res.json({
        relationship_id: req.params.id,
        events: result.rows,
        count: result.rows.length,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Internal server error';
      return res.status(500).json({ error: message });
    }
  });

  // ============================================
  // GET /api/v2/relationships/:id/alerts
  // Get alerts for a relationship
  // ============================================
  router.get('/:id/alerts', async (req: Request, res: Response) => {
    try {
      const statusFilter = req.query.status as string || 'ACTIVE';

      const result = await db.query(
        `SELECT * FROM alerts
         WHERE relationship_id = $1 AND status = $2
         ORDER BY created_at DESC
         LIMIT 50`,
        [req.params.id, statusFilter.toUpperCase()]
      );

      return res.json({
        relationship_id: req.params.id,
        alerts: result.rows,
        count: result.rows.length,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Internal server error';
      return res.status(500).json({ error: message });
    }
  });

  // ============================================
  // PATCH /api/v2/relationships/:id/alerts/:alertId
  // Acknowledge or resolve an alert
  // ============================================
  router.patch('/:id/alerts/:alertId', async (req: Request, res: Response) => {
    try {
      const { status } = req.body;

      if (!['ACKNOWLEDGED', 'RESOLVED'].includes(status)) {
        return res.status(400).json({
          error: 'Status must be ACKNOWLEDGED or RESOLVED',
        });
      }

      const timestampField = status === 'ACKNOWLEDGED' ? 'acknowledged_at' : 'resolved_at';

      const result = await db.query(
        `UPDATE alerts
         SET status = $1, ${timestampField} = NOW()
         WHERE id = $2 AND relationship_id = $3
         RETURNING *`,
        [status, req.params.alertId, req.params.id]
      );

      if (result.rows.length === 0) {
        return res.status(404).json({ error: 'Alert not found' });
      }

      return res.json(result.rows[0]);
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
