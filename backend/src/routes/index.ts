import { Router, type RequestHandler } from 'express';
import { env } from '../config/env';
import { prisma } from '../lib/prisma';
import { analyticsRoutes } from '../modules/analytics/analytics.routes';
import { auditRoutes } from '../modules/audit/audit.routes';
import { authRoutes } from '../modules/auth/auth.routes';
import { commentsRoutes } from '../modules/comments/comments.routes';
import { dashboardRoutes } from '../modules/dashboard/dashboard.routes';
import { filesRoutes } from '../modules/files/files.routes';
import { notificationsRoutes } from '../modules/notifications/notifications.routes';
import { projectsRoutes } from '../modules/projects/projects.routes';
import { tasksRoutes } from '../modules/tasks/tasks.routes';
import { invitationsRoutes } from '../modules/team/invitations.routes';
import { usersRoutes } from '../modules/users/users.routes';
import { websitesRoutes } from '../modules/websites/websites.routes';
import { widgetRoutes } from '../modules/widget/widget.routes';

export const apiRouter = (authLimiter: RequestHandler) => {
  const r = Router();

  r.get('/health', async (_req, res) => {
    await prisma.$queryRaw`SELECT 1`;
    res.json({ data: { status: 'ok', database: 'ok', time: new Date().toISOString() } });
  });

  /** Which sign-in methods the frontend should offer. */
  r.get('/auth/providers', (_req, res) => {
    res.json({ data: { password: true, google: env.googleEnabled } });
  });

  r.use('/auth', authRoutes(authLimiter));
  r.use('/users', usersRoutes());
  r.use('/dashboard', dashboardRoutes());
  r.use('/analytics', analyticsRoutes()); // reports for website owners/admins
  r.use('/audit-logs', auditRoutes()); // security audit trail
  r.use('/websites', websitesRoutes()); // + members, invitations, performance, projects
  r.use('/projects', projectsRoutes()); // + members, tasks
  r.use('/tasks', tasksRoutes()); // + activity, comments
  r.use('/comments', commentsRoutes());
  r.use('/invitations', invitationsRoutes(authLimiter));
  r.use('/notifications', notificationsRoutes());
  r.use('/files', filesRoutes()); // signed, expiring URLs for uploaded screenshots
  r.use('/widget', widgetRoutes(authLimiter)); // embeddable review widget (customer websites)

  return r;
};
