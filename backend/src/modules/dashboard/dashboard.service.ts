import { Prisma, TaskStatus, WebsiteRole } from '@prisma/client';
import { forbidden } from '../../lib/errors';
import { prisma } from '../../lib/prisma';
import {
  accessibleProjectWhere,
  accessibleTaskWhere,
  accessibleWebsiteWhere,
  getWebsiteAccess,
  isPrivateReporter,
  isSuperAdmin,
} from '../access/access.service';
import { publicUserSelect } from '../users/user.serializer';

import { CLOSED_STATUSES } from '../tasks/task-status';

const NOT_OPEN_WORK = CLOSED_STATUSES;
const TREND_DAYS = 14;

const dayKey = (d: Date) => d.toISOString().slice(0, 10);

/**
 * Live dashboard statistics, computed from the database and scoped to what the user can
 * access (platform-wide for SUPER_ADMIN). Optionally narrowed to one website.
 */
export const getStats = async (userId: string, websiteId?: string) => {
  if (websiteId) await getWebsiteAccess(userId, websiteId); // 404 if not accessible
  const superAdmin = await isSuperAdmin(userId);

  const websiteWhere: Prisma.WebsiteWhereInput = {
    AND: [await accessibleWebsiteWhere(userId), websiteId ? { id: websiteId } : {}],
  };
  const projectWhere: Prisma.ProjectWhereInput = {
    AND: [await accessibleProjectWhere(userId), websiteId ? { websiteId } : {}],
  };
  const taskWhere: Prisma.TaskWhereInput = {
    AND: [await accessibleTaskWhere(userId), websiteId ? { websiteId } : {}],
  };
  // Users: the whole platform for super admins (unless narrowed), else everyone in the websites
  // where the user is on the team. A Website User (client) never counts other people — only
  // themself — so one project's users are never exposed to another project's users.
  const userWhere: Prisma.UserWhereInput =
    superAdmin && !websiteId
      ? {}
      : superAdmin
        ? { websiteMemberships: { some: { website: websiteWhere } } }
        : {
            OR: [
              {
                websiteMemberships: {
                  some: {
                    website: {
                      AND: [websiteWhere, { members: { some: { userId, role: { not: WebsiteRole.WEBSITE_USER } } } }],
                    },
                  },
                },
              },
              { id: userId, websiteMemberships: { some: { website: websiteWhere } } },
            ],
          };

  const now = new Date();
  const since = new Date(now);
  since.setUTCHours(0, 0, 0, 0);
  since.setUTCDate(since.getUTCDate() - (TREND_DAYS - 1));

  const [
    totalWebsites,
    activeWebsites,
    totalProjects,
    totalUsers,
    byStatus,
    byPriority,
    overdue,
    recentActivity,
    createdRecently,
    completedRecently,
    myOpenTasks,
  ] = await Promise.all([
    prisma.website.count({ where: websiteWhere }),
    prisma.website.count({ where: { AND: [websiteWhere, { status: 'ACTIVE' }] } }),
    prisma.project.count({ where: projectWhere }),
    prisma.user.count({ where: userWhere }),
    prisma.task.groupBy({ by: ['status'], where: taskWhere, _count: true }),
    prisma.task.groupBy({ by: ['priority'], where: { AND: [taskWhere, { status: { notIn: NOT_OPEN_WORK } }] }, _count: true }),
    prisma.task.count({ where: { AND: [taskWhere, { status: { notIn: NOT_OPEN_WORK }, dueDate: { lt: now } }] } }),
    prisma.taskActivity.findMany({
      where: { task: taskWhere },
      select: {
        id: true,
        type: true,
        changes: true,
        createdAt: true,
        actor: { select: publicUserSelect },
        task: { select: { id: true, title: true, project: { select: { id: true, name: true } } } },
      },
      orderBy: { createdAt: 'desc' },
      take: 12,
    }),
    prisma.task.findMany({ where: { AND: [taskWhere, { createdAt: { gte: since } }] }, select: { createdAt: true } }),
    prisma.task.findMany({ where: { AND: [taskWhere, { completedAt: { gte: since } }] }, select: { completedAt: true } }),
    prisma.task.count({ where: { AND: [taskWhere, { assigneeId: userId, status: { notIn: NOT_OPEN_WORK } }] } }),
  ]);

  const statusCount = (s: TaskStatus) => byStatus.find((r) => r.status === s)?._count ?? 0;
  const totalTasks = byStatus.reduce((sum, r) => sum + r._count, 0);
  const completed = statusCount('COMPLETED');
  const nonArchived = totalTasks - statusCount('ARCHIVED');

  const trend = Array.from({ length: TREND_DAYS }, (_, i) => {
    const d = new Date(since);
    d.setUTCDate(d.getUTCDate() + i);
    return { date: dayKey(d), created: 0, completed: 0 };
  });
  const index = new Map(trend.map((t, i) => [t.date, i]));
  for (const t of createdRecently) {
    const i = index.get(dayKey(t.createdAt));
    if (i !== undefined) trend[i]!.created++;
  }
  for (const t of completedRecently) {
    const i = t.completedAt ? index.get(dayKey(t.completedAt)) : undefined;
    if (i !== undefined) trend[i]!.completed++;
  }

  return {
    scope: websiteId ? 'website' : superAdmin ? 'platform' : 'workspace',
    totals: {
      websites: totalWebsites,
      activeWebsites,
      projects: totalProjects,
      users: totalUsers,
      tasks: totalTasks,
      openTasks: statusCount('OPEN') + statusCount('REOPENED'),
      inProgressTasks: statusCount('IN_PROGRESS') + statusCount('IN_REVIEW'),
      completedTasks: completed,
      overdueTasks: overdue,
      myOpenTasks,
    },
    tasksByStatus: Object.values(TaskStatus).map((status) => ({ status, count: statusCount(status) })),
    openTasksByPriority: (['URGENT', 'HIGH', 'MEDIUM', 'LOW'] as const).map((priority) => ({
      priority,
      count: byPriority.find((r) => r.priority === priority)?._count ?? 0,
    })),
    completionRate: nonArchived ? Math.round((completed / nonArchived) * 100) : 0,
    trend,
    recentActivity,
  };
};

/**
 * Dashboard → "Projects": every website (project) the user can open, with the user's role and
 * live counts. Super admins get the whole platform. A Website User sees only the websites they
 * belong to, their own task counts, and no user counts (other people stay private).
 */
export const listWebsites = async (userId: string) => {
  const superAdmin = await isSuperAdmin(userId);
  const [websites, taskGroups] = await Promise.all([
    prisma.website.findMany({
      where: await accessibleWebsiteWhere(userId),
      select: {
        id: true,
        name: true,
        url: true,
        status: true,
        createdAt: true,
        members: { where: { userId }, select: { role: true } },
        _count: { select: { members: true } },
      },
      orderBy: { createdAt: 'asc' },
    }),
    prisma.task.groupBy({ by: ['websiteId', 'status'], where: await accessibleTaskWhere(userId), _count: true }),
  ]);
  const projectGroups = await prisma.project.groupBy({
    by: ['websiteId'],
    where: { AND: [await accessibleProjectWhere(userId), { websiteId: { in: websites.map((w) => w.id) } }] },
    _count: true,
  });
  return websites.map((w) => {
    const role: WebsiteRole = w.members[0]?.role ?? WebsiteRole.OWNER; // super admins: virtual owner
    const groups = taskGroups.filter((g) => g.websiteId === w.id);
    const count = (pred: (s: TaskStatus) => boolean) => groups.filter((g) => pred(g.status)).reduce((n, g) => n + g._count, 0);
    const team = superAdmin || !isPrivateReporter(role);
    return {
      id: w.id,
      name: w.name,
      url: w.url,
      status: w.status,
      createdAt: w.createdAt,
      role,
      member: w.members.length > 0,
      users: team ? w._count.members : null,
      projects: projectGroups.find((g) => g.websiteId === w.id)?._count ?? 0,
      tasks: {
        total: count((s) => s !== 'ARCHIVED'),
        open: count((s) => s === 'OPEN' || s === 'REOPENED'),
        inProgress: count((s) => s === 'IN_PROGRESS' || s === 'IN_REVIEW'),
        completed: count((s) => s === 'COMPLETED'),
      },
    };
  });
};

/**
 * Dashboard → project selected → "Users": the website's members with their projects and how
 * many tasks each reported / has open. Team only (owners, admins, managers, developers and
 * super admins); a Website User gets 403 — they never see other users.
 */
export const websiteUsers = async (userId: string, websiteId: string) => {
  const access = await getWebsiteAccess(userId, websiteId); // 404 when not accessible
  if (isPrivateReporter(access.role)) throw forbidden('Only the website team can see its users', 'TEAM_ONLY');
  const [members, created, open, assigned] = await Promise.all([
    prisma.websiteMember.findMany({
      where: { websiteId },
      select: {
        role: true,
        createdAt: true,
        user: { select: { ...publicUserSelect, status: true, lastLoginAt: true } },
      },
      orderBy: { createdAt: 'asc' },
    }),
    prisma.task.groupBy({ by: ['creatorId'], where: { websiteId, status: { not: 'ARCHIVED' } }, _count: true }),
    prisma.task.groupBy({ by: ['creatorId'], where: { websiteId, status: { in: ['OPEN', 'REOPENED'] } }, _count: true }),
    prisma.task.groupBy({ by: ['assigneeId'], where: { websiteId, status: { notIn: NOT_OPEN_WORK } }, _count: true }),
  ]);
  const projects = await prisma.projectMember.findMany({
    where: { project: { websiteId }, userId: { in: members.map((m) => m.user.id) } },
    select: { userId: true, role: true, project: { select: { id: true, name: true } } },
  });
  return members.map((m) => ({
    user: m.user,
    role: m.role,
    joinedAt: m.createdAt,
    projects: projects.filter((p) => p.userId === m.user.id).map((p) => ({ ...p.project, role: p.role })),
    tasks: {
      reported: created.find((c) => c.creatorId === m.user.id)?._count ?? 0,
      open: open.find((c) => c.creatorId === m.user.id)?._count ?? 0,
      assignedOpen: assigned.find((c) => c.assigneeId === m.user.id)?._count ?? 0,
    },
  }));
};
