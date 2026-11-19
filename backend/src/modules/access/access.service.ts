import { Prisma, ProjectRole, WebsiteRole } from '@prisma/client';
import { forbidden, notFound } from '../../lib/errors';
import { prisma, type Tx } from '../../lib/prisma';

/**
 * Tenant isolation & role-based access control.
 *
 * Tenant = Website. A user only sees Websites they are a member of (platform SUPER_ADMINs
 * see every website, acting as its OWNER). Resources the user cannot access are reported
 * as 404 (not 403) so their existence is not leaked.
 *
 * Team (website) roles
 *   OWNER            – created the website; everything incl. deletion and managing admins
 *   ADMIN            – manage website, settings, team (except admins/owner) and all projects
 *   PROJECT_MANAGER  – create projects; manages the projects they belong to
 *   DEVELOPER        – works on tasks in the projects they belong to
 *   WEBSITE_USER     – the client / site reviewer: reports & discusses issues (REVIEWER/VIEWER only)
 *
 * Project roles (OWNER/ADMIN of the website are implicitly MANAGER of every project)
 *   MANAGER     – manage project + members, full control of all tasks & comments
 *   CONTRIBUTOR – developers: create/edit any task, run the workflow (start, status, assign,
 *                 priority, complete, reopen, archive), comment
 *   REVIEWER    – create tasks (feedback), edit the content of / delete own tasks, comment, add
 *                 screenshots to own tasks (no workflow changes)
 *   VIEWER      – read-only
 */

export type WebsitePermission =
  | 'website:read'
  | 'website:update'
  | 'website:delete'
  | 'website:members:manage'
  | 'website:settings:update'
  | 'project:create'
  | 'project:delete';

const WEBSITE_PERMISSIONS: Record<WebsiteRole, readonly WebsitePermission[]> = {
  OWNER: [
    'website:read',
    'website:update',
    'website:delete',
    'website:members:manage',
    'website:settings:update',
    'project:create',
    'project:delete',
  ],
  ADMIN: [
    'website:read',
    'website:update',
    'website:members:manage',
    'website:settings:update',
    'project:create',
    'project:delete',
  ],
  PROJECT_MANAGER: ['website:read', 'project:create'],
  DEVELOPER: ['website:read'],
  WEBSITE_USER: ['website:read'],
};

export type ProjectPermission =
  | 'project:read'
  | 'task:manage'
  | 'project:update'
  | 'project:members:manage'
  | 'task:create'
  | 'task:update:any'
  | 'task:update:own'
  | 'task:delete:any'
  | 'task:delete:own'
  | 'comment:create'
  | 'comment:delete:any';

const PROJECT_PERMISSIONS: Record<ProjectRole, readonly ProjectPermission[]> = {
  MANAGER: [
    'project:read',
    'project:update',
    'project:members:manage',
    'task:manage',
    'task:create',
    'task:update:any',
    'task:update:own',
    'task:delete:any',
    'task:delete:own',
    'comment:create',
    'comment:delete:any',
  ],
  CONTRIBUTOR: ['project:read', 'task:manage', 'task:create', 'task:update:any', 'task:update:own', 'task:delete:own', 'comment:create'],
  REVIEWER: ['project:read', 'task:create', 'task:update:own', 'task:delete:own', 'comment:create'],
  VIEWER: ['project:read'],
};

/** Which project roles each team role may hold. */
export const ALLOWED_PROJECT_ROLES: Record<WebsiteRole, readonly ProjectRole[]> = {
  OWNER: ['MANAGER', 'CONTRIBUTOR', 'REVIEWER', 'VIEWER'],
  ADMIN: ['MANAGER', 'CONTRIBUTOR', 'REVIEWER', 'VIEWER'],
  PROJECT_MANAGER: ['MANAGER', 'CONTRIBUTOR', 'REVIEWER', 'VIEWER'],
  DEVELOPER: ['CONTRIBUTOR', 'REVIEWER', 'VIEWER'],
  WEBSITE_USER: ['REVIEWER', 'VIEWER'],
};

/** Default project role when a team member is assigned to a project. */
export const DEFAULT_PROJECT_ROLE: Record<WebsiteRole, ProjectRole> = {
  OWNER: 'MANAGER',
  ADMIN: 'MANAGER',
  PROJECT_MANAGER: 'MANAGER',
  DEVELOPER: 'CONTRIBUTOR',
  WEBSITE_USER: 'REVIEWER',
};

export const websiteCan = (role: WebsiteRole, permission: WebsitePermission) =>
  WEBSITE_PERMISSIONS[role].includes(permission);

export const projectCan = (role: ProjectRole, permission: ProjectPermission) =>
  PROJECT_PERMISSIONS[role].includes(permission);

export const isWebsiteManager = (role: WebsiteRole) => role === WebsiteRole.OWNER || role === WebsiteRole.ADMIN;

type Db = typeof prisma | Tx;

export const isSuperAdmin = async (userId: string, db: Db = prisma): Promise<boolean> => {
  const u = await db.user.findUnique({ where: { id: userId }, select: { role: true } });
  return u?.role === 'SUPER_ADMIN';
};

/** Membership role, or OWNER for platform super admins, or null. */
const effectiveWebsiteRole = async (userId: string, websiteId: string, db: Db): Promise<WebsiteRole | null> => {
  const membership = await db.websiteMember.findUnique({
    where: { websiteId_userId: { websiteId, userId } },
    select: { role: true },
  });
  if (membership) return membership.role;
  if (await isSuperAdmin(userId, db)) {
    const exists = await db.website.findUnique({ where: { id: websiteId }, select: { id: true } });
    return exists ? WebsiteRole.OWNER : null;
  }
  return null;
};

// ───────────────────────────── Scoping filters for cross-tenant lists ─────────────────────────────

/** Websites the user can see. */
export const accessibleWebsiteWhere = async (userId: string): Promise<Prisma.WebsiteWhereInput> =>
  (await isSuperAdmin(userId)) ? {} : { members: { some: { userId } } };

/** Projects the user can see: all projects of websites they manage + projects they belong to. */
export const accessibleProjectWhere = async (userId: string): Promise<Prisma.ProjectWhereInput> =>
  (await isSuperAdmin(userId))
    ? {}
    : {
        OR: [
          { website: { members: { some: { userId, role: { in: [WebsiteRole.OWNER, WebsiteRole.ADMIN] } } } } },
          { members: { some: { userId } } },
        ],
      };

/**
 * Private reporting: Website Users (clients/reviewers) only ever see the tasks they created
 * themselves — never other clients' tasks, comments or history. The team (owners, admins,
 * project managers, developers) and platform super admins keep seeing the project's tasks.
 */
export const isPrivateReporter = (websiteRole: WebsiteRole) => websiteRole === WebsiteRole.WEBSITE_USER;

export const accessibleTaskWhere = async (userId: string): Promise<Prisma.TaskWhereInput> =>
  (await isSuperAdmin(userId))
    ? {}
    : {
        OR: [
          // Team members: every task of the projects they can access
          {
            project: await accessibleProjectWhere(userId),
            website: { members: { some: { userId, role: { not: WebsiteRole.WEBSITE_USER } } } },
          },
          // Website Users: only their own tasks (in projects they belong to)
          {
            creatorId: userId,
            project: { members: { some: { userId } } },
            website: { members: { some: { userId, role: WebsiteRole.WEBSITE_USER } } },
          },
        ],
      };

// ───────────────────────────── Website ─────────────────────────────

export interface WebsiteAccess {
  websiteId: string;
  role: WebsiteRole;
}

export const getWebsiteAccess = async (userId: string, websiteId: string, db: Db = prisma): Promise<WebsiteAccess> => {
  const role = await effectiveWebsiteRole(userId, websiteId, db);
  if (!role) throw notFound('Website not found');
  return { websiteId, role };
};

export const requireWebsitePermission = async (
  userId: string,
  websiteId: string,
  permission: WebsitePermission,
  db: Db = prisma,
): Promise<WebsiteAccess> => {
  const access = await getWebsiteAccess(userId, websiteId, db);
  if (!websiteCan(access.role, permission)) throw forbidden();
  return access;
};

// ───────────────────────────── Project ─────────────────────────────

export interface ProjectAccess {
  projectId: string;
  websiteId: string;
  websiteRole: WebsiteRole;
  /** Effective role (website OWNER/ADMIN ⇒ MANAGER). */
  role: ProjectRole;
}

/** Effective project role for a user, or null if they have no access. */
export const resolveProjectRole = async (
  userId: string,
  project: { id: string; websiteId: string },
  db: Db = prisma,
): Promise<{ websiteRole: WebsiteRole; role: ProjectRole } | null> => {
  const websiteRole = await effectiveWebsiteRole(userId, project.websiteId, db);
  if (!websiteRole) return null;
  if (isWebsiteManager(websiteRole)) return { websiteRole, role: ProjectRole.MANAGER };
  const pm = await db.projectMember.findUnique({
    where: { projectId_userId: { projectId: project.id, userId } },
    select: { role: true },
  });
  return pm ? { websiteRole, role: pm.role } : null;
};

export const getProjectAccess = async (userId: string, projectId: string, db: Db = prisma): Promise<ProjectAccess> => {
  const project = await db.project.findUnique({ where: { id: projectId }, select: { id: true, websiteId: true } });
  if (!project) throw notFound('Project not found');
  const resolved = await resolveProjectRole(userId, project, db);
  if (!resolved) throw notFound('Project not found');
  return { projectId, websiteId: project.websiteId, ...resolved };
};

export const requireProjectPermission = async (
  userId: string,
  projectId: string,
  permission: ProjectPermission,
  db: Db = prisma,
): Promise<ProjectAccess> => {
  const access = await getProjectAccess(userId, projectId, db);
  if (!projectCan(access.role, permission)) throw forbidden();
  return access;
};

// ───────────────────────────── Task ─────────────────────────────

export interface TaskAccess extends ProjectAccess {
  taskId: string;
  creatorId: string | null;
  isCreator: boolean;
}

export const getTaskAccess = async (userId: string, taskId: string, db: Db = prisma): Promise<TaskAccess> => {
  const task = await db.task.findUnique({
    where: { id: taskId },
    select: { id: true, projectId: true, websiteId: true, creatorId: true },
  });
  if (!task) throw notFound('Task not found');
  const resolved = await resolveProjectRole(userId, { id: task.projectId, websiteId: task.websiteId }, db);
  if (!resolved) throw notFound('Task not found');
  // Another client's task: same answer as a task that doesn't exist (nothing leaks).
  if (isPrivateReporter(resolved.websiteRole) && task.creatorId !== userId) throw notFound('Task not found');
  return {
    taskId: task.id,
    projectId: task.projectId,
    websiteId: task.websiteId,
    creatorId: task.creatorId,
    isCreator: task.creatorId === userId,
    ...resolved,
  };
};

/** Workflow fields (status, priority, assignee, due date) and archiving: admins + developers. */
export const canManageTask = (access: ProjectAccess) => projectCan(access.role, 'task:manage');

/** "any" permission, or the "own" variant when the user created the task. */
export const canOnTask = (access: TaskAccess, action: 'update' | 'delete') =>
  projectCan(access.role, `task:${action}:any`) || (access.isCreator && projectCan(access.role, `task:${action}:own`));
