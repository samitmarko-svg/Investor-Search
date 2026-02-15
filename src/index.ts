/**
 * Investor-Search Application Entry Point
 *
 * Relationship-centric investment infrastructure platform.
 */

import express from 'express';
import { Pool } from 'pg';
import { createRelationshipRouter } from '../api/v2/relationships';
import { verifyHandlerCompleteness } from './integrity/calculator';

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

app.listen(port, () => {
  console.log(`Investor-Search running on port ${port}`);
});

export default app;
