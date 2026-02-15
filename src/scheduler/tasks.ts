/**
 * Scheduler and Periodic Tasks
 *
 * Uses setInterval-based scheduling for periodic tasks.
 * In production, replace with a proper job queue (bull, pg-boss, etc.).
 */

import { Pool } from 'pg';
import { SilenceDetector } from '../signals/silence';
import { TemporalAgent } from '../agents/temporal';
import { EventPropagator } from '../events/propagation';
import { Snapshot } from '../types/relationship_types';

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

interface ScheduledTask {
  name: string;
  interval: number;
  lastRun: Date | null;
  run: () => Promise<void>;
}

export class TaskScheduler {
  private tasks: ScheduledTask[] = [];
  private timers: NodeJS.Timeout[] = [];
  private running = false;

  constructor(private db: Pool) {
    this.registerTasks();
  }

  /**
   * Start all periodic tasks.
   */
  start(): void {
    if (this.running) return;
    this.running = true;

    for (const task of this.tasks) {
      const timer = setInterval(async () => {
        try {
          console.log(`[Scheduler] Running task: ${task.name}`);
          await task.run();
          task.lastRun = new Date();
          console.log(`[Scheduler] Completed task: ${task.name}`);
        } catch (err) {
          console.error(
            `[Scheduler] Task ${task.name} failed:`,
            err instanceof Error ? err.message : err
          );
        }
      }, task.interval);

      this.timers.push(timer);
    }

    console.log(`[Scheduler] Started ${this.tasks.length} periodic tasks`);
  }

  /**
   * Stop all periodic tasks.
   */
  stop(): void {
    for (const timer of this.timers) {
      clearInterval(timer);
    }
    this.timers = [];
    this.running = false;
    console.log('[Scheduler] Stopped all tasks');
  }

  /**
   * Get status of all tasks.
   */
  getStatus(): Array<{ name: string; interval_hours: number; last_run: string | null }> {
    return this.tasks.map((t) => ({
      name: t.name,
      interval_hours: t.interval / HOUR_MS,
      last_run: t.lastRun?.toISOString() || null,
    }));
  }

  /**
   * Manually trigger a task by name.
   */
  async runTask(taskName: string): Promise<void> {
    const task = this.tasks.find((t) => t.name === taskName);
    if (!task) {
      throw new Error(`Unknown task: ${taskName}`);
    }

    await task.run();
    task.lastRun = new Date();
  }

  private registerTasks(): void {
    // Silence detection (daily)
    this.tasks.push({
      name: 'detect-silence',
      interval: DAY_MS,
      lastRun: null,
      run: async () => {
        const detector = new SilenceDetector(this.db);
        const results = await detector.detectAll();
        const eventsTotal = results.reduce(
          (sum, r) => sum + r.events_emitted.length,
          0
        );
        console.log(
          `[detect-silence] Checked ${results.length} relationships, emitted ${eventsTotal} events`
        );
      },
    });

    // Temporal pattern refresh (daily)
    this.tasks.push({
      name: 'refresh-temporal-patterns',
      interval: DAY_MS,
      lastRun: null,
      run: async () => {
        const agent = new TemporalAgent();

        const relationships = await this.db.query(
          `SELECT id FROM relationships
           WHERE status IN ('ACTIVE', 'PAUSED')
           AND deleted_at IS NULL`
        );

        let count = 0;
        for (const rel of relationships.rows) {
          try {
            const snapshots = await this.db.query(
              `SELECT * FROM snapshots
               WHERE relationship_id = $1
               ORDER BY snapshot_date ASC`,
              [rel.id]
            );

            if (snapshots.rows.length < 2) continue;

            const analysis = agent.analyze(snapshots.rows as Snapshot[]);
            if (!('status' in analysis)) {
              const latestSnapshot = snapshots.rows[snapshots.rows.length - 1];
              await agent.persist(this.db, rel.id, latestSnapshot.id, analysis);
              count++;
            }
          } catch (err) {
            console.error(
              `Pattern analysis failed for ${rel.id}:`,
              err instanceof Error ? err.message : err
            );
          }
        }

        console.log(`[refresh-temporal-patterns] Refreshed ${count} patterns`);
      },
    });

    // Stale RI recalculation (daily)
    this.tasks.push({
      name: 'recalculate-stale-ri',
      interval: DAY_MS,
      lastRun: null,
      run: async () => {
        const { calculateIntegrityForType } = await import(
          '../integrity/calculator'
        );

        // Find relationships with RI older than 7 days
        const stale = await this.db.query(
          `SELECT DISTINCT r.id, r.relationship_type
           FROM relationships r
           JOIN integrity_scores i ON i.relationship_id = r.id
           WHERE r.status IN ('ACTIVE', 'PAUSED')
           AND r.deleted_at IS NULL
           GROUP BY r.id, r.relationship_type
           HAVING MAX(i.calculated_at) < NOW() - INTERVAL '7 days'`
        );

        let count = 0;
        const propagator = new EventPropagator(this.db);

        for (const rel of stale.rows) {
          try {
            const snapshots = await this.db.query(
              `SELECT * FROM snapshots
               WHERE relationship_id = $1
               ORDER BY snapshot_date DESC`,
              [rel.id]
            );

            if (snapshots.rows.length === 0) continue;

            const ri = calculateIntegrityForType(rel, snapshots.rows as Snapshot[]);
            const latestSnapshot = snapshots.rows[0];

            await this.db.query(
              `INSERT INTO integrity_scores
               (relationship_id, snapshot_id, smi, components, calculated_at)
               VALUES ($1, $2, $3, $4, NOW())`,
              [rel.id, latestSnapshot.id, ri.smi, JSON.stringify(ri.components)]
            );

            await propagator.emitAndPropagate(rel.id, 'ri_calculated', {
              smi: ri.smi,
              recalculation: true,
            });

            count++;
          } catch (err) {
            console.error(
              `RI recalculation failed for ${rel.id}:`,
              err instanceof Error ? err.message : err
            );
          }
        }

        console.log(`[recalculate-stale-ri] Recalculated ${count} scores`);
      },
    });
  }
}
