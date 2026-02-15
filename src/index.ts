/**
 * Investor-Search Application Entry Point
 *
 * Relationship-centric investment infrastructure platform.
 * Includes async pipeline, temporal analysis, event propagation,
 * silence detection, and periodic task scheduling.
 */

import express from 'express';
import { Pool } from 'pg';
import { createRelationshipRouter } from '../api/v2/relationships';
import { verifyHandlerCompleteness } from './integrity/calculator';
import { TaskScheduler } from './scheduler/tasks';
import { collectPipelineHealth } from './monitoring/pipeline_health';

const app = express();
const port = process.env.PORT || 3000;

// Database connection
const db = new Pool({
  connectionString: process.env.DATABASE_URL,
});

// Middleware
app.use(express.json());

// Startup checks
const missingHandlers = verifyHandlerCompleteness();
if (missingHandlers.length > 0) {
  console.error(
    `FATAL: Missing integrity handlers for types: ${missingHandlers.join(', ')}`
  );
  process.exit(1);
}

// Routes
app.use('/api/v2/relationships', createRelationshipRouter(db));

// Health check
app.get('/health', async (_req, res) => {
  try {
    await db.query('SELECT 1');
    res.json({ status: 'healthy', timestamp: new Date().toISOString() });
  } catch {
    res.status(503).json({ status: 'unhealthy' });
  }
});

// Pipeline health monitoring endpoint
const scheduler = new TaskScheduler(db);

app.get('/api/v2/monitoring/health', async (_req, res) => {
  try {
    const health = await collectPipelineHealth(db);
    health.scheduler = scheduler.getStatus();
    res.json(health);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Health check failed';
    res.status(500).json({ error: message });
  }
});

// Manual task trigger (admin only)
app.post('/api/v2/monitoring/tasks/:taskName/run', async (req, res) => {
  try {
    await scheduler.runTask(req.params.taskName);
    res.json({ message: `Task ${req.params.taskName} completed` });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Task execution failed';
    res.status(500).json({ error: message });
  }
});

// Start server
app.listen(port, () => {
  console.log(`Investor-Search running on port ${port}`);

  // Start periodic task scheduler
  if (process.env.ENABLE_SCHEDULER !== 'false') {
    scheduler.start();
  }
});

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('SIGTERM received, shutting down...');
  scheduler.stop();
  db.end();
});

export default app;
