import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { Prisma } from '@prisma/client';
import { logger } from './logger';
import { prisma } from './prisma';

/**
 * Security audit trail. Append-only rows in `audit_logs` for authentication events,
 * permission changes, deletions and other sensitive actions — including failed and denied
 * attempts. Writing never blocks or fails the request.
 */

export interface AuditEntry {
  action: string;
  outcome?: 'success' | 'failure' | 'denied';
  actorId?: string | null;
  actorEmail?: string | null;
  websiteId?: string | null;
  targetType?: string | null;
  targetId?: string | null;
  statusCode?: number | null;
  ipAddress?: string | null;
  userAgent?: string | null;
  requestId?: string | null;
  metadata?: Record<string, unknown>;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const uuidOrNull = (v: unknown) => (typeof v === 'string' && UUID.test(v) ? v : null);

export const writeAudit = async (e: AuditEntry) => {
  try {
    await prisma.auditLog.create({
      data: {
        action: e.action.slice(0, 64),
        outcome: e.outcome ?? 'success',
        actorId: uuidOrNull(e.actorId),
        actorEmail: e.actorEmail?.slice(0, 320) ?? null,
        websiteId: uuidOrNull(e.websiteId),
        targetType: e.targetType ?? null,
        targetId: e.targetId?.slice(0, 64) ?? null,
        statusCode: e.statusCode ?? null,
        ipAddress: e.ipAddress?.slice(0, 64) ?? null,
        userAgent: e.userAgent?.slice(0, 512) ?? null,
        requestId: e.requestId?.slice(0, 64) ?? null,
        metadata: e.metadata as Prisma.InputJsonValue | undefined,
      },
    });
  } catch (err) {
    logger.error({ err, action: e.action }, 'audit log write failed');
  }
};

interface AuditOptions {
  /** Target type, and where its id is (a route param name). */
  target?: { type: string; param?: string };
  /** Route param holding the website id, or a function deriving it. */
  website?: string | ((req: Request) => string | undefined);
  /** Extra details (never secrets). */
  meta?: (req: Request, body: unknown) => Record<string, unknown> | undefined;
  /** Also record 4xx failures (e.g. failed logins, permission denials). Default: true. */
  failures?: boolean;
}

/**
 * Route middleware: records `action` once the response has been sent, with the outcome
 * derived from the status code (2xx success, 401/423 failure, 403/404 denied).
 */
export const audit =
  (action: string, opts: AuditOptions = {}): RequestHandler =>
  (req: Request, res: Response, next: NextFunction) => {
    // Capture now: Express restores req.params when the request leaves this router, so they
    // would be gone by the time the response has finished.
    const params = { ...req.params } as Record<string, string>;
    const json = res.json.bind(res);
    let body: unknown;
    res.json = (b: unknown) => {
      body = b;
      return json(b);
    };
    res.on('finish', () => {
      const status = res.statusCode;
      const ok = status < 400;
      if (!ok && (opts.failures === false || status >= 500 || status === 400)) return;
      const data = (body as { data?: { user?: { id?: string; email?: string } } } | undefined)?.data;
      const reqBody = (req.body ?? {}) as Record<string, unknown>;
      const websiteId =
        typeof opts.website === 'function' ? opts.website(req) : opts.website ? params[opts.website] : undefined;
      void writeAudit({
        action,
        outcome: ok ? 'success' : status === 401 || status === 423 ? 'failure' : 'denied',
        actorId: req.auth?.userId ?? data?.user?.id ?? null,
        actorEmail: req.auth?.email ?? data?.user?.email ?? (typeof reqBody.email === 'string' ? reqBody.email.toLowerCase() : null),
        websiteId: websiteId ?? null,
        targetType: opts.target?.type ?? null,
        targetId: opts.target?.param ? (params[opts.target.param] ?? null) : null,
        statusCode: status,
        ipAddress: req.ip ?? null,
        userAgent: req.get('user-agent') ?? null,
        requestId: (req as Request & { id?: string }).id ?? null,
        metadata: opts.meta?.(req, body),
      });
    });
    next();
  };
