import { Prisma, WebsiteRole } from '@prisma/client';
import { Router } from 'express';
import { z } from 'zod';
import { forbidden } from '../../lib/errors';
import { paginated, paginationQuery, toSkipTake } from '../../lib/pagination';
import { prisma } from '../../lib/prisma';
import { authOf, authenticate, requireVerifiedEmail } from '../../middleware/authenticate';
import { queryOf, validate } from '../../middleware/validate';
import { isSuperAdmin } from '../access/access.service';

export const auditQuery = paginationQuery.extend({
  action: z.string().trim().max(64).optional(),
  outcome: z.enum(['success', 'failure', 'denied']).optional(),
  websiteId: z.string().uuid().optional(),
  actorId: z.string().uuid().optional(),
  q: z.string().trim().max(200).optional(),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
  pageSize: z.coerce.number().int().min(1).max(100).default(50),
});

/**
 * GET /audit-logs — the security audit trail (read-only; there is no API to change it).
 * Super admins: everything. Website owners/admins: only entries for their websites (websiteId required).
 */
export const auditRoutes = () => {
  const r = Router();
  r.use(authenticate, requireVerifiedEmail);
  r.get('/', validate({ query: auditQuery }), async (req, res) => {
    const { userId } = authOf(req);
    const q = queryOf(req, auditQuery);
    if (!(await isSuperAdmin(userId))) {
      if (!q.websiteId) throw forbidden('Only platform admins can see the whole audit log', 'AUDIT_FORBIDDEN');
      const m = await prisma.websiteMember.findUnique({ where: { websiteId_userId: { websiteId: q.websiteId, userId } } });
      if (!m || (m.role !== WebsiteRole.OWNER && m.role !== WebsiteRole.ADMIN)) throw forbidden(undefined, 'AUDIT_FORBIDDEN');
    }
    const where: Prisma.AuditLogWhereInput = {
      ...(q.action ? { action: { startsWith: q.action } } : {}),
      ...(q.outcome ? { outcome: q.outcome } : {}),
      ...(q.websiteId ? { websiteId: q.websiteId } : {}),
      ...(q.actorId ? { actorId: q.actorId } : {}),
      ...(q.q ? { OR: [{ actorEmail: { contains: q.q, mode: 'insensitive' } }, { ipAddress: { contains: q.q } }, { action: { contains: q.q } }] } : {}),
      ...(q.from || q.to ? { createdAt: { ...(q.from ? { gte: q.from } : {}), ...(q.to ? { lte: q.to } : {}) } } : {}),
    };
    const [items, total] = await prisma.$transaction([
      prisma.auditLog.findMany({ where, orderBy: { createdAt: 'desc' }, ...toSkipTake(q) }),
      prisma.auditLog.count({ where }),
    ]);
    res.json({ data: paginated(items, total, q) });
  });
  return r;
};
