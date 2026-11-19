import {
  AttachmentKind,
  Prisma,
  ProjectRole,
  TaskStatus,
  WebsiteRole,
  type TaskPriority,
  type TaskType,
} from '@prisma/client';
import { env } from '../../config/env';
import { badRequest, forbidden, notFound } from '../../lib/errors';
import { paginated, toSkipTake } from '../../lib/pagination';
import { prisma } from '../../lib/prisma';
import { signedFileUrl } from '../../lib/storage';
import { writeAudit } from '../../lib/audit';
import { accessibleTaskWhere, DEFAULT_PROJECT_ROLE, getTaskAccess, getWebsiteAccess, isWebsiteManager, projectCan } from '../access/access.service';
import { issueWidgetHandoff } from '../auth/auth.service';
import * as comments from '../comments/comments.service';
import { ACTIVE_STATUSES, DONE_STATUSES, OPEN_STATUSES } from '../tasks/task-status';
import * as tasks from '../tasks/tasks.service';
import { taskKey } from '../tasks/tasks.service';
import { publicUserSelect, selfUserSelect, toSelfProfile } from '../users/user.serializer';
import { hostOfOrigin, isOriginAllowed } from './widget.origin';
import { elementAnchor, type ElementAnchor, type Tab } from './widget.schemas';

// ───────────────────────────── Site resolution ─────────────────────────────

const siteSelect = {
  id: true,
  name: true,
  url: true,
  logoUrl: true,
  status: true,
  siteId: true,
  settings: {
    select: {
      allowedDomains: true,
      widgetEnabled: true,
      widgetProjectId: true,
      brandColor: true,
      clientsCanCreateTasks: true,
      widgetAutoJoin: true,
    },
  },
} satisfies Prisma.WebsiteSelect;

export type WidgetSite = Prisma.WebsiteGetPayload<{ select: typeof siteSelect }>;

/** Throws unless the website exists, its widget is enabled, and `origin` is an allowed domain. */
const assertUsable = (site: WidgetSite | null, origin: string | undefined): WidgetSite => {
  if (!site) throw notFound('Unknown Site ID', 'SITE_NOT_FOUND');
  if (site.settings && !site.settings.widgetEnabled) {
    throw forbidden('The review widget is turned off for this website', 'WIDGET_DISABLED');
  }
  if (site.status === 'INACTIVE') throw forbidden('This website is inactive', 'WEBSITE_INACTIVE');
  if (!isOriginAllowed(origin, site, site.settings?.allowedDomains ?? [])) {
    const host = origin ? hostOfOrigin(origin) : null;
    throw forbidden(
      host ? `The review widget is not allowed on ${host}. Add it under Allowed domains.` : 'Request origin is required',
      'DOMAIN_NOT_ALLOWED',
    );
  }
  return site;
};

export const siteForOrigin = async (siteId: string, origin: string | undefined) =>
  assertUsable(await prisma.website.findUnique({ where: { siteId }, select: siteSelect }), origin);

export const siteByIdForOrigin = async (websiteId: string, origin: string | undefined) =>
  assertUsable(await prisma.website.findUnique({ where: { id: websiteId }, select: siteSelect }), origin);

/**
 * Dashboard "Show on page": the task's page link (…?wrtm_task=<id>) plus, when that page is
 * one where this website's widget runs, a single-use sign-in ticket, so the person arrives
 * already signed in to the widget instead of being asked to log in again.
 *
 * The ticket is only ever put into links to the website's own allowed domains: a page URL
 * pointing anywhere else (it is reported by the widget) gets the plain link, so a ticket can
 * never be handed to a third-party site.
 */
export const reviewLink = async (userId: string, taskId: string) => {
  await getTaskAccess(userId, taskId); // same visibility rules as opening the task in the dashboard
  const task = await prisma.task.findUniqueOrThrow({
    where: { id: taskId },
    select: { pageUrl: true, website: { select: siteSelect } },
  });
  if (!task.pageUrl) throw badRequest('This task is not linked to a page', 'NO_PAGE_URL');
  let url: URL;
  try {
    url = new URL(task.pageUrl);
  } catch {
    throw badRequest('This task is not linked to a valid page', 'NO_PAGE_URL');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw badRequest('This task is not linked to a valid page', 'NO_PAGE_URL');
  url.searchParams.set('wrtm_task', taskId);

  const site = task.website;
  const widgetRuns =
    site.status !== 'INACTIVE' &&
    site.settings?.widgetEnabled !== false &&
    isOriginAllowed(url.origin, site, site.settings?.allowedDomains ?? []);
  if (!widgetRuns) return { url: url.href, signedIn: false };

  const ticket = await issueWidgetHandoff(userId, site.id);
  // In the fragment (never sent to the website's server or in Referer headers); pages that
  // already use the fragment (hash routing) get it as a query parameter instead.
  if (url.hash) url.searchParams.set('wrtm_ticket', ticket);
  else url.hash = `wrtm_ticket=${ticket}`;
  return { url: url.href, signedIn: true };
};

/** Public bootstrap data. Contains nothing that isn't already visible on the customer's page. */
export const config = (site: WidgetSite) => ({
  site: {
    siteId: site.siteId,
    name: site.name,
    logoUrl: site.logoUrl,
    brandColor: site.settings?.brandColor ?? null,
  },
  auth: { password: true, registration: true, google: env.googleEnabled },
});

// ───────────────────────────── Access ─────────────────────────────

interface Roles {
  websiteRole: WebsiteRole;
  manager: boolean;
  /** Explicit project memberships (managers implicitly MANAGER everywhere). */
  projectRoles: Map<string, ProjectRole>;
}

const rolesFor = async (userId: string, websiteId: string): Promise<Roles | null> => {
  const access = await getWebsiteAccess(userId, websiteId).catch(() => null);
  if (!access) return null;
  const manager = isWebsiteManager(access.role);
  const memberships = manager
    ? []
    : await prisma.projectMember.findMany({
        where: { userId, project: { websiteId } },
        select: { projectId: true, role: true },
      });
  return {
    websiteRole: access.role,
    manager,
    projectRoles: new Map(memberships.map((m) => [m.projectId, m.role])),
  };
};

const roleIn = (roles: Roles, projectId: string): ProjectRole | null =>
  roles.manager ? ProjectRole.MANAGER : (roles.projectRoles.get(projectId) ?? null);

const requireRoles = async (userId: string, websiteId: string, site?: WidgetSite) => {
  const roles = (await rolesFor(userId, websiteId)) ?? (site ? await joinOnSignIn(userId, site) : null);
  if (!roles) throw forbidden("You don't have access to review this website", 'NO_SITE_ACCESS');
  return roles;
};

/**
 * Auto-join (website setting "widgetAutoJoin", on by default): someone who signs in through
 * this website's own widget becomes a Website User of it and a member of its feedback project,
 * so they can report straight away and the website's team sees them under its users.
 * Website Users only ever see their own tasks, so joining reveals nothing about other people.
 * Requires a verified email (when verification is on). Turned off, only invited members
 * can review (the original behaviour).
 */
const joinOnSignIn = async (userId: string, site: WidgetSite): Promise<Roles | null> => {
  if (site.settings && !site.settings.widgetAutoJoin) return null;
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { email: true, status: true, emailVerifiedAt: true } });
  if (!user || user.status !== 'ACTIVE') return null;
  if (env.REQUIRE_EMAIL_VERIFICATION && !user.emailVerifiedAt) return null;

  const owner = await prisma.websiteMember.findFirst({ where: { websiteId: site.id, role: WebsiteRole.OWNER }, select: { userId: true } });
  // The project new widget feedback goes to: the website's widget project if it is active,
  // else its "Website Feedback" project (created on first use, owned by the website owner).
  const preferred = site.settings?.widgetProjectId
    ? await prisma.project.findFirst({ where: { id: site.settings.widgetProjectId, websiteId: site.id, status: 'ACTIVE' }, select: { id: true } })
    : null;
  let projectId = preferred?.id ?? null;
  if (!projectId) {
    projectId = await ensureFeedbackProject(owner?.userId ?? userId, site.id).catch(() => null);
  }

  try {
    await prisma.$transaction(async (tx) => {
      await tx.websiteMember.create({ data: { websiteId: site.id, userId, role: WebsiteRole.WEBSITE_USER } });
      if (projectId) {
        await tx.projectMember.upsert({
          where: { projectId_userId: { projectId, userId } },
          create: { projectId, userId, role: DEFAULT_PROJECT_ROLE.WEBSITE_USER },
          update: {},
        });
      }
    });
  } catch (err) {
    // Two requests joined at once: the other one already did it.
    if (!(err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002')) throw err;
  }
  void writeAudit({
    action: 'member.auto_joined',
    actorId: userId,
    actorEmail: user.email,
    websiteId: site.id,
    targetType: 'user',
    targetId: userId,
    metadata: { role: WebsiteRole.WEBSITE_USER, projectId, via: 'widget' },
  });
  return rolesFor(userId, site.id);
};

/** Active projects the user may file feedback in. */
const creatableProjects = async (roles: Roles, site: WidgetSite) => {
  if (roles.websiteRole === WebsiteRole.WEBSITE_USER && site.settings && !site.settings.clientsCanCreateTasks) return [];
  const projects = await prisma.project.findMany({
    where: { websiteId: site.id, status: 'ACTIVE', ...(roles.manager ? {} : { id: { in: [...roles.projectRoles.keys()] } }) },
    select: { id: true, name: true },
    orderBy: { createdAt: 'asc' },
  });
  return projects.filter((p) => {
    const role = roleIn(roles, p.id);
    return role !== null && projectCan(role, 'task:create');
  });
};

const DEFAULT_FEEDBACK_PROJECT = 'Website Feedback';

export const me = async (userId: string, site: WidgetSite) => {
  const user = toSelfProfile(await prisma.user.findUniqueOrThrow({ where: { id: userId }, select: selfUserSelect }));
  const roles = (await rolesFor(userId, site.id)) ?? (await joinOnSignIn(userId, site));
  if (!roles) return { user, access: null, counts: null };

  const projects = await creatableProjects(roles, site);
  const preferred = site.settings?.widgetProjectId;
  const defaultProjectId = projects.find((p) => p.id === preferred)?.id ?? projects[0]?.id ?? null;
  // Owners/admins can always report: a "Website Feedback" project is created on first use.
  const canCreate = projects.length > 0 || roles.manager;
  const counts = user.emailVerified || !env.REQUIRE_EMAIL_VERIFICATION ? await countsFor(userId, site.id, {}) : null;
  return {
    user,
    access: { role: roles.websiteRole, canCreate, projects, defaultProjectId },
    counts,
  };
};

// ───────────────────────────── Tasks ─────────────────────────────
// The widget uses the same task service as the dashboard (permissions, Task IDs, activity
// log, notifications); this module only adds the website boundary and the widget's views.

const tabWhere = (tab: Tab): Prisma.TaskWhereInput => {
  switch (tab) {
    case 'open':
      return { status: { in: OPEN_STATUSES } };
    case 'in_progress':
      return { status: { in: ACTIVE_STATUSES } };
    case 'done':
      return { status: { in: DONE_STATUSES } };
    case 'archived':
      return { status: TaskStatus.ARCHIVED };
    default:
      return { status: { not: TaskStatus.ARCHIVED } };
  }
};

/** Same page regardless of query string, hash, or a trailing slash. */
const pageWhere = (pageUrl: string): Prisma.TaskWhereInput => {
  const u = new URL(pageUrl);
  const base = u.origin + u.pathname.replace(/\/+$/, '');
  const prefixes = [`${base}?`, `${base}#`, `${base}/?`, `${base}/#`];
  return {
    OR: [
      { pageUrl: base },
      { pageUrl: `${base}/` },
      ...prefixes.map((p) => ({ pageUrl: { startsWith: p } })),
    ],
  };
};

interface Filters {
  pageUrl?: string;
  mine?: boolean;
  q?: string;
}

const baseWhere = async (userId: string, websiteId: string, f: Filters): Promise<Prisma.TaskWhereInput> => {
  const keyMatch = f.q?.match(/^(?:task-|#)?(\d{1,9})$/i);
  return {
    AND: [
      { websiteId },
      await accessibleTaskWhere(userId),
      f.pageUrl ? pageWhere(f.pageUrl) : {},
      f.mine ? { OR: [{ creatorId: userId }, { assigneeId: userId }] } : {},
      f.q
        ? {
            OR: [
              { title: { contains: f.q, mode: 'insensitive' } },
              { description: { contains: f.q, mode: 'insensitive' } },
              { pageUrl: { contains: f.q, mode: 'insensitive' } },
              ...(keyMatch ? [{ number: Number(keyMatch[1]) }] : []),
            ],
          }
        : {},
    ],
  };
};

const countsFor = async (userId: string, websiteId: string, f: Filters) => {
  const byStatus = await prisma.task.groupBy({ by: ['status'], where: await baseWhere(userId, websiteId, f), _count: { _all: true } });
  const n = (statuses: TaskStatus[]) =>
    byStatus.filter((s) => statuses.includes(s.status)).reduce((sum, s) => sum + s._count._all, 0);
  return {
    all: n(Object.values(TaskStatus).filter((s) => s !== TaskStatus.ARCHIVED)),
    open: n(OPEN_STATUSES),
    in_progress: n(ACTIVE_STATUSES),
    done: n(DONE_STATUSES),
    archived: n([TaskStatus.ARCHIVED]),
  };
};

const widgetTaskSelect = {
  id: true,
  number: true,
  projectId: true,
  title: true,
  description: true,
  status: true,
  type: true,
  priority: true,
  pageUrl: true,
  metadata: true,
  createdAt: true,
  updatedAt: true,
  completedAt: true,
  archivedAt: true,
  creatorId: true,
  creator: { select: publicUserSelect },
  assignee: { select: publicUserSelect },
  project: { select: { id: true, name: true } },
  attachments: {
    where: { commentId: null, kind: AttachmentKind.SCREENSHOT },
    select: { id: true },
    orderBy: { createdAt: 'asc' },
    take: 1,
  },
  _count: { select: { comments: true, attachments: true } },
} satisfies Prisma.TaskSelect;

type WidgetTaskRow = Prisma.TaskGetPayload<{ select: typeof widgetTaskSelect }>;

const permissionsFor = (role: ProjectRole, isCreator: boolean) => {
  const manage = projectCan(role, 'task:manage');
  return {
    manage,
    update: projectCan(role, 'task:update:any') || (isCreator && projectCan(role, 'task:update:own')),
    comment: projectCan(role, 'comment:create'),
    upload: manage || (isCreator && projectCan(role, 'task:create')),
    archive: manage,
  };
};

/** The stored element anchor, or null (older tasks, page-level comments). */
const anchorOf = (v: unknown): ElementAnchor | null => {
  const parsed = elementAnchor.safeParse(v);
  return parsed.success ? parsed.data : null;
};

const serialize = (t: WidgetTaskRow, userId: string, roles: Roles, unread: number) => {
  const role = roleIn(roles, t.projectId) ?? ProjectRole.VIEWER;
  const meta = (t.metadata ?? {}) as Record<string, unknown>;
  const { attachments, _count, metadata: _m, creatorId, ...rest } = t;
  return {
    ...rest,
    key: taskKey(t.number),
    pageTitle: typeof meta.pageTitle === 'string' ? meta.pageTitle : null,
    element: anchorOf(meta.element),
    screenshotUrl: attachments[0] ? signedFileUrl(attachments[0].id) : null,
    commentCount: _count.comments,
    attachmentCount: _count.attachments,
    unreadCount: unread,
    permissions: permissionsFor(role, creatorId === userId),
  };
};

export const listTasks = async (
  userId: string,
  site: WidgetSite,
  query: Filters & { tab: Tab; page: number; pageSize: number },
) => {
  const roles = await requireRoles(userId, site.id, site);
  const base = await baseWhere(userId, site.id, query);
  const where: Prisma.TaskWhereInput = { AND: [base, tabWhere(query.tab)] };
  const [items, total, counts] = await Promise.all([
    prisma.task.findMany({
      where,
      select: widgetTaskSelect,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      ...toSkipTake(query),
    }),
    prisma.task.count({ where }),
    countsFor(userId, site.id, query),
  ]);
  const unread = await tasks.unreadCounts(
    userId,
    items.map((t) => t.id),
  );
  return {
    ...paginated(
      items.map((t) => serialize(t, userId, roles, unread.get(t.id) ?? 0)),
      total,
      query,
    ),
    counts,
  };
};

/** 404 unless the task belongs to this website and the user can see it. */
const ensureTask = async (userId: string, websiteId: string, taskId: string) => {
  const roles = await requireRoles(userId, websiteId);
  const t = await prisma.task.findFirst({
    where: { AND: [{ id: taskId, websiteId }, await accessibleTaskWhere(userId)] },
    select: widgetTaskSelect,
  });
  if (!t) throw notFound('Task not found');
  return { roles, row: t };
};

const loadTask = async (userId: string, websiteId: string, taskId: string) => {
  const { roles, row } = await ensureTask(userId, websiteId, taskId);
  const unread = await tasks.unreadCounts(userId, [taskId]);
  return serialize(row, userId, roles, unread.get(taskId) ?? 0);
};

/** Full task for the widget's detail view (all screenshots and files). */
export const getTask = async (userId: string, websiteId: string, taskId: string) => {
  const summary = await loadTask(userId, websiteId, taskId);
  const full = await tasks.get(userId, taskId);
  return { ...summary, dueDate: full.dueDate, attachments: full.attachments.filter((a) => !a.commentId) };
};

const ensureFeedbackProject = async (userId: string, websiteId: string) => {
  const existing = await prisma.project.findUnique({ where: { websiteId_name: { websiteId, name: DEFAULT_FEEDBACK_PROJECT } } });
  if (existing) {
    if (existing.status !== 'ACTIVE') {
      throw badRequest('There is no active project to file feedback in. Create or reactivate a project first.', 'NO_PROJECT');
    }
    return existing.id;
  }
  try {
    const p = await prisma.project.create({
      data: {
        websiteId,
        name: DEFAULT_FEEDBACK_PROJECT,
        description: 'Feedback submitted through the website review widget.',
        createdById: userId,
        members: { create: { userId, role: ProjectRole.MANAGER } },
      },
    });
    await prisma.websiteSettings.upsert({
      where: { websiteId },
      create: { websiteId, widgetProjectId: p.id },
      update: { widgetProjectId: p.id },
    });
    return p.id;
  } catch (err) {
    // Two first tasks at once: the other request created it.
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
      return (await prisma.project.findUniqueOrThrow({ where: { websiteId_name: { websiteId, name: DEFAULT_FEEDBACK_PROJECT } } })).id;
    }
    throw err;
  }
};

export const createTask = async (
  userId: string,
  site: WidgetSite,
  input: {
    title: string;
    description?: string;
    type: TaskType;
    priority?: TaskPriority;
    projectId?: string;
    pageUrl: string;
    pageTitle?: string;
    element?: ElementAnchor;
    context?: Record<string, unknown>;
  },
) => {
  const roles = await requireRoles(userId, site.id, site);
  const projects = await creatableProjects(roles, site);

  let projectId: string;
  if (input.projectId) {
    if (!projects.some((p) => p.id === input.projectId)) throw notFound('Project not found');
    projectId = input.projectId;
  } else {
    const preferred = projects.find((p) => p.id === site.settings?.widgetProjectId) ?? projects[0];
    if (preferred) projectId = preferred.id;
    else if (roles.manager) projectId = await ensureFeedbackProject(userId, site.id);
    else if (roles.websiteRole === WebsiteRole.WEBSITE_USER && site.settings && !site.settings.clientsCanCreateTasks) {
      throw forbidden('Clients are not allowed to create tasks on this website', 'CLIENT_TASKS_DISABLED');
    } else throw forbidden("You aren't assigned to a project on this website yet", 'NO_PROJECT');
  }

  // Page URL must belong to this website's allowed domains (it's where the widget ran).
  if (!isOriginAllowed(new URL(input.pageUrl).origin, site, site.settings?.allowedDomains ?? [])) {
    throw badRequest('Page URL is not on this website', 'INVALID_PAGE_URL');
  }

  const task = await tasks.create(userId, projectId, {
    title: input.title,
    description: input.description || undefined,
    type: input.type,
    priority: input.priority,
    pageUrl: input.pageUrl,
    // Captured automatically: website (task.websiteId), reporter (creatorId), time (createdAt),
    // page URL and title, plus the browser/viewport context.
    metadata: { source: 'widget', pageTitle: input.pageTitle ?? null, ...(input.context ?? {}), element: input.element ?? null },
  });
  return loadTask(userId, site.id, task.id);
};

export const updateTask = async (userId: string, websiteId: string, taskId: string, input: tasks.UpdateTaskInput) => {
  await ensureTask(userId, websiteId, taskId);
  await tasks.update(userId, taskId, input);
  return getTask(userId, websiteId, taskId);
};

/** Archive = status ARCHIVED; restore = back to the status it had before. */
export const setArchived = async (userId: string, websiteId: string, taskId: string, archived: boolean) => {
  await ensureTask(userId, websiteId, taskId);
  if (archived) await tasks.update(userId, taskId, { status: TaskStatus.ARCHIVED });
  else await tasks.restore(userId, taskId);
  return loadTask(userId, websiteId, taskId);
};

export const activity = async (userId: string, websiteId: string, taskId: string) => {
  await ensureTask(userId, websiteId, taskId);
  return tasks.listActivity(userId, taskId, { page: 1, pageSize: 100 });
};

export const assignees = async (userId: string, websiteId: string, taskId: string) => {
  await ensureTask(userId, websiteId, taskId);
  return tasks.assignees(userId, taskId);
};

export const markRead = async (userId: string, websiteId: string, taskId: string) => {
  await ensureTask(userId, websiteId, taskId);
  await tasks.markRead(userId, taskId);
};

export const addAttachment = async (
  userId: string,
  websiteId: string,
  taskId: string,
  input: { body: unknown; fileName: string; kind: AttachmentKind; commentId?: string },
) => {
  await ensureTask(userId, websiteId, taskId);
  return tasks.addAttachment(userId, taskId, input);
};

export const removeAttachment = async (userId: string, websiteId: string, taskId: string, attachmentId: string) => {
  await ensureTask(userId, websiteId, taskId);
  await tasks.removeAttachment(userId, taskId, attachmentId);
};

export const listComments = async (userId: string, websiteId: string, taskId: string, query: { page: number; pageSize: number }) => {
  await ensureTask(userId, websiteId, taskId);
  return comments.list(userId, taskId, query);
};

export const addComment = async (userId: string, websiteId: string, taskId: string, input: { body: string; parentId?: string }) => {
  await ensureTask(userId, websiteId, taskId);
  return comments.create(userId, taskId, input);
};

const ensureComment = async (userId: string, websiteId: string, commentId: string) => {
  const c = await prisma.taskComment.findUnique({ where: { id: commentId }, select: { taskId: true } });
  if (!c) throw notFound('Comment not found');
  await ensureTask(userId, websiteId, c.taskId).catch(() => {
    throw notFound('Comment not found');
  });
};

export const editComment = async (userId: string, websiteId: string, commentId: string, body: string) => {
  await ensureComment(userId, websiteId, commentId);
  return comments.update(userId, commentId, body);
};

export const deleteComment = async (userId: string, websiteId: string, commentId: string) => {
  await ensureComment(userId, websiteId, commentId);
  await comments.remove(userId, commentId);
};
