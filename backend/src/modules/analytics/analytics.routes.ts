import { Router } from 'express';
import { z } from 'zod';
import { authOf, authenticate, requireVerifiedEmail } from '../../middleware/authenticate';
import { queryOf, validate } from '../../middleware/validate';
import * as analytics from './analytics.service';

const day = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD')
  .transform((v) => new Date(`${v}T00:00:00Z`))
  .refine((d) => !Number.isNaN(d.getTime()), 'Invalid date');

export const analyticsQuery = z
  .object({
    from: day.optional(),
    to: day.optional(),
    interval: z.enum(['day', 'week', 'month']).default('day'),
    websiteId: z.string().uuid().optional(),
    projectId: z.string().uuid().optional(),
  })
  .transform((q) => {
    const to = q.to ?? new Date();
    const from = q.from ?? new Date(to.getTime() - 29 * 86_400_000); // last 30 days
    return { ...q, from, to };
  });

/** GET /analytics, GET /analytics/tasks.csv (website owners/admins; super admins see everything). */
export const analyticsRoutes = () => {
  const r = Router();
  r.use(authenticate, requireVerifiedEmail);

  r.get('/', validate({ query: analyticsQuery }), async (req, res) => {
    res.json({ data: await analytics.getAnalytics(authOf(req).userId, queryOf(req, analyticsQuery)) });
  });

  r.get('/tasks.csv', validate({ query: analyticsQuery }), async (req, res) => {
    const q = queryOf(req, analyticsQuery);
    const csv = await analytics.tasksCsv(authOf(req).userId, q);
    const name = `tasks-${q.from.toISOString().slice(0, 10)}-to-${q.to.toISOString().slice(0, 10)}.csv`;
    res.set({ 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="${name}"`, 'Cache-Control': 'no-store' });
    res.send(`﻿${csv}`); // BOM so Excel opens UTF-8 correctly
  });

  return r;
};
