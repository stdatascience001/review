import { Prisma, ProjectRole, TaskStatus, type ProjectStatus } from '@prisma/client';
import { deleteFiles } from '../../lib/storage';
import { badRequest, conflict, notFound } from '../../lib/errors';
import { paginated, toSkipTake, type Pagination } from '../../lib/pagination';
import { prisma } from '../../lib/prisma';
import {
  ALLOWED_PROJECT_ROLES,
  DEFAULT_PROJECT_ROLE,
  accessibleProjectWhere,
  getWebsiteAccess,
  isWebsiteManager,
  requireProjectPermission,
  requireWebsitePermission,
} from '../access/access.service';
import { notify } from '../notifications/notifications.service';
import { publicUserSelect } from '../users/user.serializer';

import { CLOSED_STATUSES, DONE_STATUSES as DONE } from '../tasks/task-status';

const projectSelect = {
  id: true,
  websiteId: true,
  name: true,
  description: true,
  status: true,
  startDate: true,
  dueDate: true,
  createdById: true,
  createdAt: true,
  updatedAt: true,
} satisfies Prisma.ProjectSelect;

const listSelect = {
  ...projectSelect,
  website: { select: { id: true, name: true, logoUrl: true } },
  members: { select: { role: true, user: { select: publicUserSelect } }, take: 8 },
  _count: { select: { tasks: true, members: true } },
} satisfies Prisma.ProjectSelect;

const mapUniqueName = (err: unknown): never => {
  if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
    throw conflict('A project with this name already exists in this website', 'PROJECT_NAME_TAKEN');
  }
  throw err;
};

/** Adds { progress: { total, completed, percent } } to each project. */
const withProgress = async <T extends { id: string }>(projects: T[]) => {
  if (projects.length === 0) return [] as (T & { progress: { total: number; completed: number; percent: number } })[];
  const counts = await prisma.task.groupBy({
    by: ['projectId', 'status'],
    // Archived tasks don't count towards progress.
    where: { projectId: { in: projects.map((p) => p.id) }, status: { not: 'ARCHIVED' } },
    _count: true,
  });
  return projects.map((p) => {
    const rows = counts.filter((c) => c.projectId === p.id);
    const total = rows.reduce((s, r) => s + r._count, 0);
    const completed = rows.filter((r) => DONE.includes(r.status)).reduce((s, r) => s + r._count, 0);
    return { ...p, progress: { total, completed, percent: total ? Math.round((completed / total) * 100) : 0 } };
  });
};

const searchWhere = (q?: string): Prisma.ProjectWhereInput =>
  q
    ? {
        OR: [
          { name: { contains: q, mode: 'insensitive' } },
          { description: { contains: q, mode: 'insensitive' } },
        ],
      }
    : {};

/** All projects the user can access, across websites. */
export const listAll = async (
  userId: string,
  query: Pagination & { status?: ProjectStatus; q?: string; websiteId?: string },
) => {
  const where: Prisma.ProjectWhereInput = {
    AND: [
      await accessibleProjectWhere(userId),
      query.websiteId ? { websiteId: query.websiteId } : {},
      query.status ? { status: query.status } : {},
      searchWhere(query.q),
    ],
  };
  const [items, total] = await prisma.$transaction([
    prisma.project.findMany({ where, select: listSelect, orderBy: [{ updatedAt: 'desc' }], ...toSkipTake(query) }),
    prisma.project.count({ where }),
  ]);
  return paginated(await withProgress(items), total, query);
};

export const listForWebsite = async (
  userId: string,
  websiteId: string,
  query: Pagination & { status?: ProjectStatus; q?: string },
) => {
  const access = await getWebsiteAccess(userId, websiteId);
  const where: Prisma.ProjectWhereInput = {
    websiteId,
    status: query.status,
    ...searchWhere(query.q),
    ...(isWebsiteManager(access.role) ? {} : { members: { some: { userId } } }),
  };
  const [items, total] = await prisma.$transaction([
    prisma.project.findMany({ where, select: listSelect, orderBy: [{ status: 'asc' }, { updatedAt: 'desc' }], ...toSkipTake(query) }),
    prisma.project.count({ where }),
  ]);
  return paginated(await withProgress(items), total, query);
};

export const create = async (
  userId: string,
  websiteId: string,
  input: {
    name: string;
    description?: string;
    status?: ProjectStatus;
    startDate?: Date;
    dueDate?: Date;
    memberIds?: string[];
  },
) => {
  await requireWebsitePermission(userId, websiteId, 'project:create');
  const { memberIds = [], ...data } = input;

  // Assigned team members must belong to the website (tenant isolation).
  const memberships = memberIds.length
    ? await prisma.websiteMember.findMany({ where: { websiteId, userId: { in: memberIds } } })
    : [];
  if (memberships.length !== new Set(memberIds).size) {
    throw badRequest('All assigned members must belong to the website', 'NOT_WEBSITE_MEMBER');
  }

  try {
    return await prisma.$transaction(async (tx) => {
      const project = await tx.project.create({ data: { ...data, websiteId, createdById: userId }, select: projectSelect });
      await tx.projectMember.create({ data: { projectId: project.id, userId, role: ProjectRole.MANAGER } });
      for (const m of memberships.filter((m) => m.userId !== userId)) {
        await tx.projectMember.create({ data: { projectId: project.id, userId: m.userId, role: DEFAULT_PROJECT_ROLE[m.role] } });
      }
      await notify(
        tx,
        memberships.map((m) => m.userId),
        {
          type: 'PROJECT_MEMBER_ADDED',
          title: `You were added to project ${project.name}`,
          actorId: userId,
          websiteId,
          data: { projectId: project.id },
        },
      );
      return { ...project, role: ProjectRole.MANAGER };
    });
  } catch (err) {
    return mapUniqueName(err);
  }
};

export const get = async (userId: string, projectId: string) => {
  const access = await requireProjectPermission(userId, projectId, 'project:read');
  const project = await prisma.project.findUniqueOrThrow({
    where: { id: projectId },
    select: {
      ...projectSelect,
      website: { select: { id: true, name: true, slug: true, url: true, logoUrl: true, status: true } },
      _count: { select: { tasks: true, members: true } },
    },
  });
  const taskCounts = await prisma.task.groupBy({ by: ['status'], where: { projectId }, _count: true });
  const overdue = await prisma.task.count({ where: { projectId, status: { notIn: CLOSED_STATUSES }, dueDate: { lt: new Date() } } });
  const [withProg] = await withProgress([project]);
  return {
    ...withProg!,
    role: access.role,
    websiteRole: access.websiteRole,
    overdueTasks: overdue,
    taskCountsByStatus: Object.fromEntries(taskCounts.map((t) => [t.status, t._count])),
  };
};

export const update = async (
  userId: string,
  projectId: string,
  data: Prisma.ProjectUpdateInput & { startDate?: Date | null; dueDate?: Date | null },
) => {
  const access = await requireProjectPermission(userId, projectId, 'project:update');
  if (data.startDate !== undefined || data.dueDate !== undefined) {
    const current = await prisma.project.findUniqueOrThrow({ where: { id: projectId } });
    const start = data.startDate !== undefined ? data.startDate : current.startDate;
    const due = data.dueDate !== undefined ? data.dueDate : current.dueDate;
    if (start && due && due < start) throw badRequest('Deadline must be on or after the start date', 'INVALID_DATES');
  }
  try {
    const project = await prisma.project.update({ where: { id: projectId }, data, select: projectSelect });
    return { ...project, role: access.role };
  } catch (err) {
    return mapUniqueName(err);
  }
};

export const remove = async (userId: string, projectId: string) => {
  const access = await requireProjectPermission(userId, projectId, 'project:read');
  await requireWebsitePermission(userId, access.websiteId, 'project:delete');
  const files = await prisma.taskAttachment.findMany({ where: { task: { projectId } }, select: { storageKey: true } });
  await prisma.project.delete({ where: { id: projectId } });
  await deleteFiles(files.map((f) => f.storageKey));
};

// ───────────────────────────── Members ─────────────────────────────

const memberSelect = { id: true, role: true, createdAt: true, user: { select: publicUserSelect } } as const;

export const listMembers = async (userId: string, projectId: string) => {
  await requireProjectPermission(userId, projectId, 'project:read');
  return prisma.projectMember.findMany({ where: { projectId }, select: memberSelect, orderBy: { createdAt: 'asc' } });
};

const assertRoleAllowed = (websiteRole: keyof typeof ALLOWED_PROJECT_ROLES, role: ProjectRole) => {
  if (!ALLOWED_PROJECT_ROLES[websiteRole].includes(role)) {
    throw badRequest(
      `This team member can only be ${ALLOWED_PROJECT_ROLES[websiteRole].join(' or ')} on a project`,
      'INVALID_PROJECT_ROLE',
    );
  }
};

export const addMember = async (actorId: string, projectId: string, input: { userId: string; role?: ProjectRole }) => {
  const access = await requireProjectPermission(actorId, projectId, 'project:members:manage');
  const websiteMembership = await prisma.websiteMember.findUnique({
    where: { websiteId_userId: { websiteId: access.websiteId, userId: input.userId } },
  });
  if (!websiteMembership) throw badRequest('User must be a member of the website first', 'NOT_WEBSITE_MEMBER');
  const role = input.role ?? DEFAULT_PROJECT_ROLE[websiteMembership.role];
  assertRoleAllowed(websiteMembership.role, role);

  return prisma.$transaction(async (tx) => {
    const existing = await tx.projectMember.findUnique({ where: { projectId_userId: { projectId, userId: input.userId } } });
    if (existing) throw conflict('User is already a member of this project', 'ALREADY_MEMBER');
    const member = await tx.projectMember.create({ data: { projectId, userId: input.userId, role }, select: memberSelect });
    const project = await tx.project.findUniqueOrThrow({ where: { id: projectId }, select: { name: true } });
    await notify(tx, [input.userId], {
      type: 'PROJECT_MEMBER_ADDED',
      title: `You were added to project ${project.name}`,
      actorId,
      websiteId: access.websiteId,
      data: { projectId, role },
    });
    return member;
  });
};

export const updateMember = async (actorId: string, projectId: string, targetUserId: string, role: ProjectRole) => {
  const access = await requireProjectPermission(actorId, projectId, 'project:members:manage');
  const member = await prisma.projectMember.findUnique({ where: { projectId_userId: { projectId, userId: targetUserId } } });
  if (!member) throw notFound('Project member not found');
  const websiteMembership = await prisma.websiteMember.findUniqueOrThrow({
    where: { websiteId_userId: { websiteId: access.websiteId, userId: targetUserId } },
  });
  assertRoleAllowed(websiteMembership.role, role);
  return prisma.projectMember.update({ where: { id: member.id }, data: { role }, select: memberSelect });
};

export const removeMember = async (actorId: string, projectId: string, targetUserId: string) => {
  await requireProjectPermission(actorId, projectId, actorId === targetUserId ? 'project:read' : 'project:members:manage');
  const result = await prisma.projectMember.deleteMany({ where: { projectId, userId: targetUserId } });
  if (result.count === 0) throw notFound('Project member not found');
};
