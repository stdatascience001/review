import { Prisma, TaskStatus, WebsiteRole } from '@prisma/client';
import { badRequest, forbidden, notFound } from '../../lib/errors';
import { prisma } from '../../lib/prisma';
import { isSuperAdmin } from '../access/access.service';
import { publicUserSelect } from '../users/user.serializer';
import { ACTIVE_STATUSES, CLOSED_STATUSES, DONE_STATUSES, OPEN_STATUSES } from '../tasks/task-status';
import { taskKey } from '../tasks/tasks.service';

/**
 * Admin analytics, computed from the database. Scope: every website for platform super
 * admins; otherwise the websites the user owns or administers. Time-based numbers use the
 * [from, to] range (UTC days); "current" numbers (open, overdue…) are a live snapshot.
 */

export interface AnalyticsQuery {
  from: Date;
  to: Date; // inclusive (end of this UTC day)
  interval: 'day' | 'week' | 'month';
  websiteId?: string;
  projectId?: string;
}

const MAX_DAYS = { day: 366, week: 731, month: 1830 } as const;

const scopeFor = async (userId: string, q: AnalyticsQuery) => {
  const superAdmin = await isSuperAdmin(userId);
  const managed = superAdmin
    ? await prisma.website.findMany({ select: { id: true, name: true } })
    : (
        await prisma.websiteMember.findMany({
          where: { userId, role: { in: [WebsiteRole.OWNER, WebsiteRole.ADMIN] } },
          select: { website: { select: { id: true, name: true } } },
        })
      ).map((m) => m.website);
  if (!superAdmin && managed.length === 0) {
    throw forbidden('Analytics are available to website owners and admins', 'ANALYTICS_FORBIDDEN');
  }
  let websites = managed;
  if (q.websiteId) {
    websites = managed.filter((w) => w.id === q.websiteId);
    if (!websites.length) throw notFound('Website not found');
  }
  if (q.projectId) {
    const p = await prisma.project.findUnique({ where: { id: q.projectId }, select: { websiteId: true } });
    if (!p || !websites.some((w) => w.id === p.websiteId)) throw notFound('Project not found');
  }
  return { superAdmin, websites, ids: websites.map((w) => w.id) };
};

const rangeOf = (q: AnalyticsQuery) => {
  const from = new Date(Date.UTC(q.from.getUTCFullYear(), q.from.getUTCMonth(), q.from.getUTCDate()));
  const to = new Date(Date.UTC(q.to.getUTCFullYear(), q.to.getUTCMonth(), q.to.getUTCDate(), 23, 59, 59, 999));
  if (to < from) throw badRequest('"to" must be on or after "from"', 'INVALID_RANGE');
  const days = Math.ceil((to.getTime() - from.getTime()) / 86_400_000);
  if (days > MAX_DAYS[q.interval]) throw badRequest(`Range too long for a ${q.interval} report (max ${MAX_DAYS[q.interval]} days)`, 'INVALID_RANGE');
  return { from, to };
};

const hours = (v: number | null | undefined) => (v === null || v === undefined ? null : Math.round(v * 10) / 10);

export const getAnalytics = async (userId: string, q: AnalyticsQuery) => {
  const { ids, websites } = await scopeFor(userId, q);
  const { from, to } = rangeOf(q);
  const now = new Date();

  const scope: Prisma.TaskWhereInput = { websiteId: { in: ids }, ...(q.projectId ? { projectId: q.projectId } : {}) };
  const created: Prisma.TaskWhereInput = { AND: [scope, { createdAt: { gte: from, lte: to } }] };
  const projectSql = q.projectId ? Prisma.sql`AND t.project_id = ${q.projectId}::uuid` : Prisma.empty;
  const interval = Prisma.raw(`'${q.interval}'`); // whitelisted by the schema
  // Task times are stored as UTC "timestamp without time zone": convert parameters explicitly,
  // independent of the database session's time zone.
  const utc = (d: Date) => Prisma.sql`(${d.toISOString()}::timestamptz AT TIME ZONE 'UTC')`;
  const F = utc(from);
  const T = utc(to);
  const NOW = utc(now);

  const [
    projects,
    users,
    byStatus,
    overdueBySite,
    createdInRange,
    completedInRange,
    reopenedInRange,
    byType,
    byPriority,
    timeline,
    siteRows,
    devRows,
  ] = await Promise.all([
    prisma.project.count({ where: { websiteId: { in: ids }, ...(q.projectId ? { id: q.projectId } : {}) } }),
    prisma.user.count({ where: { websiteMemberships: { some: { websiteId: { in: ids } } } } }),
    prisma.task.groupBy({ by: ['websiteId', 'status'], where: scope, _count: true }),
    prisma.task.groupBy({
      by: ['websiteId'],
      where: { AND: [scope, { dueDate: { lt: now }, status: { notIn: CLOSED_STATUSES } }] },
      _count: true,
    }),
    prisma.task.count({ where: created }),
    prisma.task.count({ where: { AND: [scope, { completedAt: { gte: from, lte: to } }] } }),
    prisma.taskActivity.count({ where: { type: 'REOPENED', createdAt: { gte: from, lte: to }, task: scope } }),
    prisma.task.groupBy({ by: ['type'], where: created, _count: true }),
    prisma.task.groupBy({ by: ['priority'], where: created, _count: true }),
    prisma.$queryRaw<{ bucket: Date; created: number; completed: number }[]>`
      WITH buckets AS (
        SELECT generate_series(date_trunc(${interval}, ${F}), date_trunc(${interval}, ${T}), ('1 ' || ${q.interval})::interval) AS bucket
      )
      SELECT b.bucket,
        (SELECT count(*)::int FROM tasks t WHERE t.website_id = ANY(${ids}::uuid[]) ${projectSql}
           AND t.created_at >= ${F} AND t.created_at <= ${T} AND date_trunc(${interval}, t.created_at) = b.bucket) AS created,
        (SELECT count(*)::int FROM tasks t WHERE t.website_id = ANY(${ids}::uuid[]) ${projectSql}
           AND t.completed_at >= ${F} AND t.completed_at <= ${T} AND date_trunc(${interval}, t.completed_at) = b.bucket) AS completed
      FROM buckets b ORDER BY b.bucket`,
    prisma.$queryRaw<{ website_id: string; created: number; completed: number; avg_hours: number | null }[]>`
      SELECT t.website_id,
        count(*) FILTER (WHERE t.created_at BETWEEN ${F} AND ${T})::int AS created,
        count(*) FILTER (WHERE t.completed_at BETWEEN ${F} AND ${T})::int AS completed,
        AVG(EXTRACT(EPOCH FROM (t.completed_at - t.created_at)) / 3600) FILTER (WHERE t.completed_at BETWEEN ${F} AND ${T})::float AS avg_hours
      FROM tasks t WHERE t.website_id = ANY(${ids}::uuid[]) ${projectSql}
      GROUP BY t.website_id`,
    prisma.$queryRaw<
      {
        assignee_id: string;
        assigned: number;
        open: number;
        in_progress: number;
        completed: number;
        completed_in_range: number;
        overdue: number;
        avg_hours: number | null;
      }[]
    >`
      SELECT t.assignee_id,
        count(*) FILTER (WHERE t.status <> 'ARCHIVED')::int AS assigned,
        count(*) FILTER (WHERE t.status IN ('OPEN', 'REOPENED'))::int AS open,
        count(*) FILTER (WHERE t.status IN ('IN_PROGRESS', 'IN_REVIEW'))::int AS in_progress,
        count(*) FILTER (WHERE t.status = 'COMPLETED')::int AS completed,
        count(*) FILTER (WHERE t.completed_at BETWEEN ${F} AND ${T})::int AS completed_in_range,
        count(*) FILTER (WHERE t.due_date < ${NOW} AND t.status NOT IN ('COMPLETED', 'ARCHIVED'))::int AS overdue,
        AVG(EXTRACT(EPOCH FROM (t.completed_at - t.created_at)) / 3600) FILTER (WHERE t.completed_at BETWEEN ${F} AND ${T})::float AS avg_hours
      FROM tasks t
      WHERE t.website_id = ANY(${ids}::uuid[]) ${projectSql} AND t.assignee_id IS NOT NULL
      GROUP BY t.assignee_id`,
  ]);

  const count = (websiteId: string | null, statuses: TaskStatus[]) =>
    byStatus
      .filter((r) => (websiteId === null || r.websiteId === websiteId) && statuses.includes(r.status))
      .reduce((s, r) => s + r._count, 0);
  const ALL = Object.values(TaskStatus);
  const overdueTotal = overdueBySite.reduce((s, r) => s + r._count, 0);
  const avgAll = await prisma.$queryRaw<{ avg_hours: number | null }[]>`
    SELECT AVG(EXTRACT(EPOCH FROM (t.completed_at - t.created_at)) / 3600)::float AS avg_hours
    FROM tasks t WHERE t.website_id = ANY(${ids}::uuid[]) ${projectSql} AND t.completed_at BETWEEN ${F} AND ${T}`;

  const developers = devRows.length
    ? await prisma.user.findMany({ where: { id: { in: devRows.map((d) => d.assignee_id) } }, select: publicUserSelect })
    : [];

  return {
    range: { from: from.toISOString(), to: to.toISOString(), interval: q.interval },
    scope: { websites: websites.length, websiteId: q.websiteId ?? null, projectId: q.projectId ?? null },
    totals: {
      websites: websites.length,
      projects,
      users,
      tasks: count(null, ALL),
      openTasks: count(null, OPEN_STATUSES),
      inProgressTasks: count(null, ACTIVE_STATUSES),
      completedTasks: count(null, DONE_STATUSES),
      archivedTasks: count(null, [TaskStatus.ARCHIVED]),
      overdueTasks: overdueTotal,
      // in the selected range
      createdInRange,
      completedInRange,
      reopenedInRange,
      avgResolutionHours: hours(avgAll[0]?.avg_hours),
    },
    timeline: timeline.map((r) => ({ date: r.bucket.toISOString().slice(0, 10), created: r.created, completed: r.completed })),
    byWebsite: websites
      .map((w) => {
        const row = siteRows.find((r) => r.website_id === w.id);
        const total = count(w.id, ALL);
        const completed = count(w.id, DONE_STATUSES);
        const active = total - count(w.id, [TaskStatus.ARCHIVED]);
        return {
          website: w,
          total,
          open: count(w.id, OPEN_STATUSES),
          inProgress: count(w.id, ACTIVE_STATUSES),
          completed,
          archived: count(w.id, [TaskStatus.ARCHIVED]),
          overdue: overdueBySite.find((r) => r.websiteId === w.id)?._count ?? 0,
          createdInRange: row?.created ?? 0,
          completedInRange: row?.completed ?? 0,
          completionRate: active ? Math.round((completed / active) * 100) : 0,
          avgResolutionHours: hours(row?.avg_hours),
        };
      })
      .sort((a, b) => b.total - a.total || a.website.name.localeCompare(b.website.name)),
    byDeveloper: devRows
      .map((d) => ({
        user: developers.find((u) => u.id === d.assignee_id)!,
        assigned: d.assigned,
        open: d.open,
        inProgress: d.in_progress,
        completed: d.completed,
        completedInRange: d.completed_in_range,
        overdue: d.overdue,
        completionRate: d.assigned ? Math.round((d.completed / d.assigned) * 100) : 0,
        avgResolutionHours: hours(d.avg_hours),
      }))
      .filter((d) => d.user)
      .sort((a, b) => b.completedInRange - a.completedInRange || b.assigned - a.assigned),
    byType: byType.map((r) => ({ type: r.type, count: r._count })),
    byPriority: byPriority.map((r) => ({ priority: r.priority, count: r._count })),
    byStatus: ALL.map((status) => ({ status, count: count(null, [status]) })),
  };
};

const csvCell = (v: unknown) => {
  if (v === null || v === undefined) return '';
  let s = v instanceof Date ? v.toISOString() : String(v);
  // Formula-injection guard for spreadsheet apps.
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

/** Date-wise task report (tasks created in the range) as CSV. */
export const tasksCsv = async (userId: string, q: AnalyticsQuery) => {
  const { ids } = await scopeFor(userId, q);
  const { from, to } = rangeOf(q);
  const rows = await prisma.task.findMany({
    where: { websiteId: { in: ids }, ...(q.projectId ? { projectId: q.projectId } : {}), createdAt: { gte: from, lte: to } },
    select: {
      number: true,
      title: true,
      status: true,
      priority: true,
      type: true,
      createdAt: true,
      completedAt: true,
      dueDate: true,
      website: { select: { name: true } },
      project: { select: { name: true } },
      creator: { select: { name: true, email: true } },
      assignee: { select: { name: true, email: true } },
    },
    orderBy: { createdAt: 'asc' },
    take: 50_000,
  });
  const header = ['Task ID', 'Created', 'Website', 'Project', 'Title', 'Type', 'Priority', 'Status', 'Reporter', 'Assignee', 'Due', 'Completed', 'Resolution hours'];
  const lines = rows.map((t) =>
    [
      taskKey(t.number),
      t.createdAt,
      t.website.name,
      t.project.name,
      t.title,
      t.type,
      t.priority,
      t.status,
      t.creator?.email ?? '',
      t.assignee?.email ?? '',
      t.dueDate,
      t.completedAt,
      t.completedAt ? Math.round(((t.completedAt.getTime() - t.createdAt.getTime()) / 3_600_000) * 10) / 10 : '',
    ]
      .map(csvCell)
      .join(','),
  );
  return [header.join(','), ...lines].join('\r\n') + '\r\n';
};
