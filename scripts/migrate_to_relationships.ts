/**
 * Migration Script: Migrate Investment Relationships
 *
 * Converts existing company-investor pairs into the new relationship model.
 * This script is idempotent and can be safely re-run.
 *
 * Usage: npx ts-node scripts/migrate_to_relationships.ts
 */

import { Pool, PoolClient } from 'pg';
import { v4 as uuidv4 } from 'uuid';

interface MigrationResult {
  batch_id: string;
  total_processed: number;
  relationships_created: number;
  snapshots_linked: number;
  integrity_scores_linked: number;
  skipped: number;
  errors: Array<{ source_id: string; error: string }>;
  duration_ms: number;
}

const BATCH_SIZE = 100;

async function migrateInvestmentRelationships(db: Pool): Promise<MigrationResult> {
  const batchId = uuidv4();
  const startTime = Date.now();
  const result: MigrationResult = {
    batch_id: batchId,
    total_processed: 0,
    relationships_created: 0,
    snapshots_linked: 0,
    integrity_scores_linked: 0,
    skipped: 0,
    errors: [],
    duration_ms: 0,
  };

  console.log(`Starting migration batch: ${batchId}`);

  // Find all unique investor-company pairs from existing snapshots
  const pairs = await db.query(`
    SELECT DISTINCT
      s.investor_id,
      s.company_id
    FROM snapshots s
    WHERE s.relationship_id IS NULL
      AND s.investor_id IS NOT NULL
      AND s.company_id IS NOT NULL
    ORDER BY s.investor_id, s.company_id
  `);

  console.log(`Found ${pairs.rows.length} investor-company pairs to migrate`);

  // Process in batches
  for (let i = 0; i < pairs.rows.length; i += BATCH_SIZE) {
    const batch = pairs.rows.slice(i, i + BATCH_SIZE);
    console.log(`Processing batch ${Math.floor(i / BATCH_SIZE) + 1}...`);

    for (const pair of batch) {
      const client = await db.connect();
      try {
        await processPair(client, batchId, pair.investor_id, pair.company_id, result);
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        result.errors.push({
          source_id: `${pair.investor_id}-${pair.company_id}`,
          error: errorMsg,
        });
        console.error(`Error migrating pair ${pair.investor_id}-${pair.company_id}: ${errorMsg}`);
      } finally {
        client.release();
      }
      result.total_processed++;
    }
  }

  result.duration_ms = Date.now() - startTime;
  console.log(`Migration complete in ${result.duration_ms}ms`);
  console.log(`  Created: ${result.relationships_created} relationships`);
  console.log(`  Linked: ${result.snapshots_linked} snapshots`);
  console.log(`  Linked: ${result.integrity_scores_linked} integrity scores`);
  console.log(`  Skipped: ${result.skipped}`);
  console.log(`  Errors: ${result.errors.length}`);

  return result;
}

async function processPair(
  client: PoolClient,
  batchId: string,
  investorId: string,
  companyId: string,
  result: MigrationResult
): Promise<void> {
  await client.query('BEGIN');

  try {
    // Check if relationship already exists
    const existing = await client.query(
      `SELECT id FROM relationships
       WHERE entity_a_id = $1 AND entity_b_id = $2
         AND relationship_type = 'INVESTMENT'
         AND deleted_at IS NULL`,
      [investorId, companyId]
    );

    let relationshipId: string;

    if (existing.rows.length > 0) {
      // Relationship already exists, use it
      relationshipId = existing.rows[0].id;
      result.skipped++;

      await logMigration(client, batchId, 'snapshots', investorId, 'relationships', relationshipId, 'SKIPPED', {
        reason: 'Relationship already exists',
      });
    } else {
      // Create new relationship
      const relResult = await client.query(
        `INSERT INTO relationships (
           entity_a_id, entity_b_id, role_a, role_b,
           relationship_type, status, created_at, activated_at
         ) VALUES ($1, $2, 'INVESTOR', 'COMPANY', 'INVESTMENT', 'ACTIVE', NOW(), NOW())
         RETURNING id`,
        [investorId, companyId]
      );

      relationshipId = relResult.rows[0].id;
      result.relationships_created++;

      await logMigration(client, batchId, 'snapshots', investorId, 'relationships', relationshipId, 'CREATED', {
        investor_id: investorId,
        company_id: companyId,
      });
    }

    // Link orphaned snapshots
    const linkedSnapshots = await client.query(
      `UPDATE snapshots
       SET relationship_id = $1
       WHERE investor_id = $2 AND company_id = $3
         AND relationship_id IS NULL
       RETURNING id`,
      [relationshipId, investorId, companyId]
    );

    result.snapshots_linked += linkedSnapshots.rowCount || 0;

    for (const snap of linkedSnapshots.rows) {
      await logMigration(client, batchId, 'snapshots', snap.id, 'relationships', relationshipId, 'LINKED', {});
    }

    // Link orphaned integrity scores via snapshots
    const linkedScores = await client.query(
      `UPDATE integrity_scores
       SET relationship_id = $1
       WHERE snapshot_id IN (
         SELECT id FROM snapshots WHERE relationship_id = $1
       )
       AND relationship_id IS NULL
       RETURNING id`,
      [relationshipId]
    );

    result.integrity_scores_linked += linkedScores.rowCount || 0;

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  }
}

async function logMigration(
  client: PoolClient,
  batchId: string,
  sourceTable: string,
  sourceId: string,
  targetTable: string,
  targetId: string,
  action: string,
  details: Record<string, unknown>
): Promise<void> {
  await client.query(
    `INSERT INTO migration_log (
       migration_name, batch_id, source_table, source_id,
       target_table, target_id, action, details
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [
      'migrate_investment_relationships',
      batchId,
      sourceTable,
      sourceId,
      targetTable,
      targetId,
      action,
      JSON.stringify(details),
    ]
  );
}

/**
 * Validate migration results by checking for orphans and inconsistencies.
 */
async function validateMigration(db: Pool): Promise<{
  valid: boolean;
  orphaned_snapshots: number;
  orphaned_integrity_scores: number;
  unlinked_pairs: number;
}> {
  const orphanedSnapshots = await db.query(
    `SELECT COUNT(*) as count FROM snapshots
     WHERE relationship_id IS NULL
       AND investor_id IS NOT NULL
       AND company_id IS NOT NULL`
  );

  const orphanedScores = await db.query(
    `SELECT COUNT(*) as count FROM integrity_scores
     WHERE relationship_id IS NULL
       AND snapshot_id IN (SELECT id FROM snapshots WHERE relationship_id IS NOT NULL)`
  );

  const unlinkedPairs = await db.query(
    `SELECT COUNT(DISTINCT (investor_id, company_id)) as count
     FROM snapshots
     WHERE relationship_id IS NULL
       AND investor_id IS NOT NULL
       AND company_id IS NOT NULL`
  );

  const result = {
    valid: true,
    orphaned_snapshots: parseInt(orphanedSnapshots.rows[0].count, 10),
    orphaned_integrity_scores: parseInt(orphanedScores.rows[0].count, 10),
    unlinked_pairs: parseInt(unlinkedPairs.rows[0].count, 10),
  };

  result.valid = result.orphaned_snapshots === 0
    && result.orphaned_integrity_scores === 0
    && result.unlinked_pairs === 0;

  return result;
}

// ============================================
// CLI entry point
// ============================================

async function main(): Promise<void> {
  const db = new Pool({
    connectionString: process.env.DATABASE_URL,
  });

  try {
    console.log('=== Investment Relationship Migration ===\n');

    // Run migration
    const migrationResult = await migrateInvestmentRelationships(db);

    // Validate
    console.log('\n=== Validating Migration ===\n');
    const validation = await validateMigration(db);

    console.log(`  Orphaned snapshots: ${validation.orphaned_snapshots}`);
    console.log(`  Orphaned integrity scores: ${validation.orphaned_integrity_scores}`);
    console.log(`  Unlinked pairs: ${validation.unlinked_pairs}`);
    console.log(`  Valid: ${validation.valid}`);

    if (!validation.valid) {
      console.error('\nMigration validation FAILED. Review migration_log for details.');
      process.exit(1);
    }

    console.log('\nMigration completed and validated successfully.');
  } catch (err) {
    console.error('Migration failed:', err);
    process.exit(1);
  } finally {
    await db.end();
  }
}

// Run if executed directly
if (require.main === module) {
  main();
}

export { migrateInvestmentRelationships, validateMigration };
