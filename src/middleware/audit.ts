/**
 * Audit Logging Middleware
 *
 * Logs all data-modifying requests for security audit.
 * Records method, path, user, IP, status code, and request body.
 */

import { Request, Response, NextFunction } from 'express';
import { Pool } from 'pg';

export function createAuditMiddleware(db: Pool) {
  return (req: Request, res: Response, next: NextFunction): void => {
    // Only log data-modifying requests
    if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) {
      next();
      return;
    }

    const startTime = Date.now();
    const userId = req.headers['x-user-id'] as string | undefined;
    const entityId = req.headers['x-entity-id'] as string | undefined;
    const ip = getClientIp(req);

    // Capture the original end method
    const originalEnd = res.end;

    // Override res.end to log after response
    res.end = function (...args: Parameters<typeof originalEnd>) {
      // Restore original
      res.end = originalEnd;

      // Log asynchronously (don't block response)
      logAuditEntry(db, {
        method: req.method,
        path: req.originalUrl || req.path,
        user_id: userId || null,
        entity_id: entityId || null,
        ip_address: ip,
        status_code: res.statusCode,
        request_body: sanitizeBody(req.body),
        duration_ms: Date.now() - startTime,
      }).catch((err) => {
        console.error('Audit log failed:', err instanceof Error ? err.message : err);
      });

      return originalEnd.apply(res, args);
    } as typeof originalEnd;

    next();
  };
}

async function logAuditEntry(
  db: Pool,
  entry: {
    method: string;
    path: string;
    user_id: string | null;
    entity_id: string | null;
    ip_address: string;
    status_code: number;
    request_body: Record<string, unknown> | null;
    duration_ms: number;
  }
): Promise<void> {
  try {
    await db.query(
      `INSERT INTO audit_log (method, path, user_id, entity_id, ip_address, status_code, request_body)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        entry.method,
        entry.path,
        entry.user_id,
        entry.entity_id,
        entry.ip_address,
        entry.status_code,
        entry.request_body ? JSON.stringify(entry.request_body) : null,
      ]
    );
  } catch {
    // Silently fail audit logging - don't break the app
    console.error('Failed to write audit log entry');
  }
}

function getClientIp(req: Request): string {
  const forwarded = req.headers['x-forwarded-for'];
  if (typeof forwarded === 'string') {
    return forwarded.split(',')[0].trim();
  }
  return req.socket.remoteAddress || 'unknown';
}

function sanitizeBody(
  body: unknown
): Record<string, unknown> | null {
  if (!body || typeof body !== 'object') return null;

  const sanitized = { ...(body as Record<string, unknown>) };

  // Remove sensitive fields
  const sensitiveFields = ['password', 'token', 'secret', 'api_key', 'authorization'];
  for (const field of sensitiveFields) {
    if (field in sanitized) {
      sanitized[field] = '[REDACTED]';
    }
  }

  return sanitized;
}
