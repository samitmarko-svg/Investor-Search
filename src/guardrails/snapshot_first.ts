/**
 * Guardrail: Snapshot-First Architecture
 *
 * Enforces that relationships cannot be activated without snapshots,
 * and that integrity scores are always calculated automatically.
 */

import { Pool } from 'pg';
import { calculateIntegrityForType } from '../integrity/calculator';
import {
  Relationship,
  Snapshot,
  SnapshotData,
  IntegrityScore,
} from '../types/relationship_types';

/**
 * Activate a relationship. Fails if no snapshot exists.
 *
 * RULE: Cannot mark relationship ACTIVE without first snapshot.
 */
export async function activateRelationship(
  db: Pool,
  relationshipId: string
): Promise<void> {
  const snapshotCount = await db.query(
    'SELECT COUNT(*) as count FROM snapshots WHERE relationship_id = $1',
    [relationshipId]
  );

  if (parseInt(snapshotCount.rows[0].count, 10) === 0) {
    throw new Error(
      'Cannot activate relationship without first snapshot. ' +
      'Submit a snapshot before activating.'
    );
  }

  await db.query(
    `UPDATE relationships
     SET status = 'ACTIVE', activated_at = NOW()
     WHERE id = $1`,
    [relationshipId]
  );
}

/**
 * Create a snapshot with mandatory integrity calculation.
 *
 * RULE: Integrity score auto-calculated on every snapshot.
 * Cannot be manually set or skipped.
 */
export async function createSnapshot(
  db: Pool,
  relationshipId: string,
  snapshotData: SnapshotData
): Promise<Snapshot> {
  // Create snapshot
  const snapshotResult = await db.query(
    `INSERT INTO snapshots (
       relationship_id, snapshot_date, declarations, financials, context_notes, created_at
     ) VALUES ($1, $2, $3, $4, $5, NOW())
     RETURNING *`,
    [
      relationshipId,
      snapshotData.snapshot_date,
      JSON.stringify(snapshotData.declarations),
      JSON.stringify(snapshotData.financials),
      snapshotData.context_notes || null,
    ]
  );

  const snapshot = snapshotResult.rows[0];

  // MANDATORY: Calculate integrity score (cannot be skipped)
  const relationship = await getRelationship(db, relationshipId);
  const allSnapshots = await getRelationshipSnapshots(db, relationshipId);
  const integrityScore = calculateIntegrityForType(relationship, allSnapshots);

  // Store integrity score
  await db.query(
    `INSERT INTO integrity_scores (
       relationship_id, snapshot_id, smi, components, calculated_at
     ) VALUES ($1, $2, $3, $4, NOW())`,
    [
      relationshipId,
      snapshot.id,
      integrityScore.smi,
      JSON.stringify(integrityScore.components),
    ]
  );

  return snapshot;
}

async function getRelationship(db: Pool, id: string): Promise<Relationship> {
  const result = await db.query(
    'SELECT * FROM relationships WHERE id = $1 AND deleted_at IS NULL',
    [id]
  );

  if (result.rows.length === 0) {
    throw new Error(`Relationship not found: ${id}`);
  }

  return result.rows[0];
}

async function getRelationshipSnapshots(db: Pool, relationshipId: string): Promise<Snapshot[]> {
  const result = await db.query(
    'SELECT * FROM snapshots WHERE relationship_id = $1 ORDER BY snapshot_date DESC',
    [relationshipId]
  );

  return result.rows;
}
