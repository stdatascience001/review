import {
  AttachmentKind,
  Prisma,
  ProjectRole,
  TaskActivityType,
  TaskStatus,
  WebsiteRole,
  type TaskPriority,
  type TaskType,
} from '@prisma/client';
import { env } from '../../config/env';
import { badRequest, forbidden, notFound } from '../../lib/errors';
import { paginated, toSkipTake, type Pagination } from '../../lib/pagination';
import { prisma, type Tx } from '../../lib/prisma';
import { deleteFile, detectUpload, safeFileName, saveFile, signedFileUrl } from '../../lib/storage';
import {
  accessibleTaskWhere,
  canManageTask,
  canOnTask,
  getTaskAccess,
  isPrivateReporter,
  projectCan,
  requireProjectPermission,
  resolveProjectRole,
  type TaskAccess,
} from '../access/access.service';
import { notify } from '../notifications/notifications.service';
import { publishTaskEvent, taskSnapshot, type TaskEventType } from '../../lib/realtime';
import { publicUserSelect } from '../users/user.serializer';
import { CLOSED_STATUSES, DONE_STATUSES, activityForTransition, isValidTransition } from './task-status';

/** Human-friendly Task ID. */
export const taskKey = (number: number) => `TASK-${number}`;

export const taskSelect = {
  id: true,
  number: true,
  websiteId: true,
  projectId: true,
  title: true,
  description: true,
  status: true,
  priority: true,
  type: true,
  pageUrl: true,
  metadata: true,
  position: true,
  dueDate: true,
  completedAt: true,
  archivedAt: true,
  createdAt: true,
  updatedAt: true,
  creator: { select: publicUserSelect },
  assignee: { select: publicUserSelect },
  project: { select: { id: true, name: true } },
  website: { select: { id: true, name: true } },
  _count: { select: { comments: true, attachments: true } },
} satisfies Prisma.TaskSelect;

const attachmentSelect = {
  id: true,
  kind: true,
  fileName: true,
  mimeType: true,
  sizeBytes: true,
  commentId: true,
  createdAt: true,
  uploader: { select: publicUserSelect },
} satisfies Prisma.TaskAttachmentSelect;

export type AttachmentRow = Prisma.TaskAttachmentGetPayload<{ select: typeof attachmentSelect }>;
/** Files are only reachable through signed, expiring URLs. */
export const withUrl = (a: AttachmentRow) => ({ ...a, url: signedFileUrl(a.id) });

/** Project roles that can be assigned work ("developers"): managers and contributors. */
const ASSIGNABLE_ROLES: ProjectRole[] = [ProjectRole.MANAGER, ProjectRole.CONTRIBUTOR];

const assertAssignable = async (db: Tx, assigneeId: string, project: { id: string; websiteId: string }) => {
  const resolved = await resolveProjectRole(assigneeId, project, db);
  if (!resolved || !ASSIGNABLE_ROLES.includes(resolved.role)) {
    throw badRequest('Tasks can only be assigned to developers or managers of this project', 'INVALID_ASSIGNEE');
  }
};

// ───────────────────────────── Unread comments ─────────────────────────────

/** Comments by other people posted after the user last opened each task. */
export const unreadCounts = async (userId: string, taskIds: string[]): Promise<Map<string, number>> => {
  if (taskIds.length === 0) return new Map();
  const rows = await prisma.$queryRaw<{ task_id: string; n: number }[]>`
    SELECT c.task_id, count(*)::int AS n
    FROM task_comments c
    LEFT JOIN task_reads r ON r.task_id = c.task_id AND r.user_id = ${userId}::uuid
    WHERE c.task_id = ANY(${taskIds}::uuid[])
      AND c.author_id IS DISTINCT FROM ${userId}::uuid
      AND (r.last_read_at IS NULL OR c.created_at > r.last_read_at)
    GROUP BY c.task_id`;
  return new Map(rows.map((r) => [r.task_id, r.n]));
};

export const lastReadAt = async (userId: string, taskId: string) =>
  (await prisma.taskRead.findUnique({ where: { taskId_userId: { taskId, userId } } }))?.lastReadAt ?? null;

const touchRead = (db: Tx | typeof prisma, userId: string, taskId: string) =>
  db.taskRead.upsert({
    where: { taskId_userId: { taskId, userId } },
    create: { taskId, userId },
    update: { lastReadAt: new Date() },
  });

export const markRead = async (userId: string, taskId: string) => {
  await getTaskAccess(userId, taskId);
  await touchRead(prisma, userId, taskId);
};

const decorate = async <T extends { id: string; number: number }>(userId: string, items: T[]) => {
  const unread = await unreadCounts(
    userId,
    items.map((t) => t.id),
  );
  return items.map((t) => ({ ...t, key: taskKey(t.number), unreadCount: unread.get(t.id) ?? 0 }));
};

// ───────────────────────────── Queries ─────────────────────────────

export interface ListTasksQuery extends Pagination {
  status?: TaskStatus[];
  priority?: TaskPriority[];
  type?: TaskType[];
  assigneeId?: string;
  q?: string;
  sort: 'position' | 'createdAt' | 'updatedAt' | 'dueDate' | 'priority' | 'number';
  order: 'asc' | 'desc';
}

const filterWhere = (userId: string, query: ListTasksQuery): Prisma.TaskWhereInput => {
  const keyMatch = query.q?.match(/^(?:task-|#)?(\d{1,9})$/i);
  return {
    // Archived tasks are hidden unless asked for explicitly.
    status: query.status ? { in: query.status } : { not: TaskStatus.ARCHIVED },
    ...(query.priority ? { priority: { in: query.priority } } : {}),
    ...(query.type ? { type: { in: query.type } } : {}),
    ...(query.assigneeId === 'me'
      ? { assigneeId: userId }
      : query.assigneeId === 'none'
        ? { assigneeId: null }
        : query.assigneeId
          ? { assigneeId: query.assigneeId }
          : {}),
    ...(query.q
      ? {
          OR: [
            { title: { contains: query.q, mode: 'insensitive' } },
            { description: { contains: query.q, mode: 'insensitive' } },
            ...(keyMatch ? [{ number: Number(keyMatch[1]) }] : []),
          ],
        }
      : {}),
  };
};

const orderByOf = (query: ListTasksQuery): Prisma.TaskOrderByWithRelationInput[] => [
  query.sort === 'dueDate' ? { dueDate: { sort: query.order, nulls: 'last' } } : { [query.sort]: query.order },
  { createdAt: 'desc' },
];

export const list = async (userId: string, projectId: string, query: ListTasksQuery) => {
  const access = await requireProjectPermission(userId, projectId, 'project:read');
  const where: Prisma.TaskWhereInput = {
    projectId,
    ...filterWhere(userId, query),
    // Website Users only see their own tasks
    ...(isPrivateReporter(access.websiteRole) ? { creatorId: userId } : {}),
  };
  const [items, total] = await prisma.$transaction([
    prisma.task.findMany({ where, select: taskSelect, orderBy: orderByOf(query), ...toSkipTake(query) }),
    prisma.task.count({ where }),
  ]);
  return paginated(await decorate(userId, items), total, query);
};

/** Tasks across all accessible projects (tenant-scoped), for the All Tasks / My Tasks views. */
export const listAll = async (
  userId: string,
  query: ListTasksQuery & { scope: 'all' | 'mine' | 'created'; websiteId?: string; projectId?: string; overdue?: boolean },
) => {
  const where: Prisma.TaskWhereInput = {
    AND: [
      await accessibleTaskWhere(userId),
      filterWhere(userId, query),
      query.scope === 'mine' ? { assigneeId: userId } : query.scope === 'created' ? { creatorId: userId } : {},
      query.websiteId ? { websiteId: query.websiteId } : {},
      query.projectId ? { projectId: query.projectId } : {},
      query.overdue ? { dueDate: { lt: new Date() }, status: { notIn: CLOSED_STATUSES } } : {},
    ],
  };
  const [items, total] = await prisma.$transaction([
    prisma.task.findMany({ where, select: taskSelect, orderBy: orderByOf(query), ...toSkipTake(query) }),
    prisma.task.count({ where }),
  ]);
  return paginated(await decorate(userId, items), total, query);
};

const permissionsOf = (access: TaskAccess) => ({
  /** Edit title/description/type (own task for reporters). */
  update: canOnTask(access, 'update'),
  /** Start, change status/priority/assignee/due date, complete, reopen, archive. */
  manage: canManageTask(access),
  delete: canOnTask(access, 'delete'),
  comment: projectCan(access.role, 'comment:create'),
  /** Add screenshots/files to the task. */
  upload: canManageTask(access) || (access.isCreator && projectCan(access.role, 'task:create')),
});

export const get = async (userId: string, taskId: string) => {
  const access = await getTaskAccess(userId, taskId);
  const task = await prisma.task.findUniqueOrThrow({
    where: { id: taskId },
    select: {
      ...taskSelect,
      attachments: { select: attachmentSelect, orderBy: { createdAt: 'asc' } },
    },
  });
  const unread = await unreadCounts(userId, [taskId]);
  return {
    ...task,
    key: taskKey(task.number),
    unreadCount: unread.get(taskId) ?? 0,
    attachments: task.attachments.map(withUrl),
    permissions: permissionsOf(access),
  };
};

export const listActivity = async (userId: string, taskId: string, query: Pagination) => {
  await getTaskAccess(userId, taskId);
  const where = { taskId };
  const [items, total] = await prisma.$transaction([
    prisma.taskActivity.findMany({
      where,
      select: {
        id: true,
        type: true,
        field: true,
        previousValue: true,
        newValue: true,
        changes: true,
        createdAt: true,
        actor: { select: publicUserSelect },
      },
      orderBy: { createdAt: 'desc' },
      ...toSkipTake(query),
    }),
    prisma.taskActivity.count({ where }),
  ]);
  return paginated(items, total, query);
};

/** Developers/managers a task can be assigned to (for the "Assign" pickers). */
export const assignees = async (userId: string, taskId: string) => {
  const access = await getTaskAccess(userId, taskId);
  const [members, managers] = await Promise.all([
    prisma.projectMember.findMany({
      where: { projectId: access.projectId, role: { in: ASSIGNABLE_ROLES }, user: { status: 'ACTIVE' } },
      select: { role: true, user: { select: publicUserSelect } },
    }),
    prisma.websiteMember.findMany({
      where: { websiteId: access.websiteId, role: { in: [WebsiteRole.OWNER, WebsiteRole.ADMIN] }, user: { status: 'ACTIVE' } },
      select: { role: true, user: { select: publicUserSelect } },
    }),
  ]);
  const seen = new Map<string, { user: (typeof members)[number]['user']; role: string }>();
  for (const m of [...managers, ...members]) if (!seen.has(m.user.id)) seen.set(m.user.id, m);
  return [...seen.values()].sort((a, b) => a.user.name.localeCompare(b.user.name));
};

// ───────────────────────────── Activity log ─────────────────────────────

interface ActivityInput {
  taskId: string;
  actorId: string;
  type: TaskActivityType;
  field?: string;
  previousValue?: string | null;
  newValue?: string | null;
  changes?: Prisma.InputJsonValue;
}

/** Every important action: who (actor), what (type/field), previous → new value, when (createdAt). */
export const logActivity = (db: Tx | typeof prisma, a: ActivityInput) =>
  db.taskActivity.create({
    data: {
      taskId: a.taskId,
      actorId: a.actorId,
      type: a.type,
      field: a.field ?? null,
      previousValue: a.previousValue ?? null,
      newValue: a.newValue ?? null,
      changes: a.changes,
    },
  });

// ───────────────────────────── Mutations ─────────────────────────────

export interface CreateTaskInput {
  title: string;
  description?: string;
  status?: TaskStatus;
  priority?: TaskPriority;
  type?: TaskType;
  pageUrl?: string;
  metadata?: Record<string, unknown>;
  assigneeId?: string | null;
  dueDate?: Date | null;
  position?: number;
}

const userName = async (db: Tx, id: string | null | undefined) =>
  id ? ((await db.user.findUnique({ where: { id }, select: { name: true } }))?.name ?? null) : null;

export const create = async (userId: string, projectId: string, input: CreateTaskInput) => {
  const access = await requireProjectPermission(userId, projectId, 'task:create');
  const website = await prisma.website.findUniqueOrThrow({ where: { id: access.websiteId }, select: { status: true } });
  if (website.status === 'INACTIVE') {
    throw forbidden('This website is inactive. Activate it to create new tasks.', 'WEBSITE_INACTIVE');
  }
  const settings = await prisma.websiteSettings.findUnique({ where: { websiteId: access.websiteId } });
  if (access.websiteRole === WebsiteRole.WEBSITE_USER && settings && !settings.clientsCanCreateTasks) {
    throw forbidden('Clients are not allowed to create tasks on this website', 'CLIENT_TASKS_DISABLED');
  }
  // Reporters choose title/description/type/priority; workflow fields belong to the team.
  const manage = projectCan(access.role, 'task:manage');
  if (!manage && (input.assigneeId || input.dueDate || (input.status && input.status !== TaskStatus.OPEN))) {
    throw forbidden('Only developers and managers can set status, assignee or due date', 'WORKFLOW_FORBIDDEN');
  }
  const status = input.status ?? TaskStatus.OPEN;
  if (status === TaskStatus.ARCHIVED || status === TaskStatus.REOPENED) {
    throw badRequest('A new task cannot start as archived or reopened', 'INVALID_TRANSITION');
  }

  return prisma.$transaction(async (tx) => {
    if (input.assigneeId) await assertAssignable(tx, input.assigneeId, { id: projectId, websiteId: access.websiteId });

    const task = await tx.task.create({
      data: {
        ...input,
        metadata: input.metadata as Prisma.InputJsonValue | undefined,
        status,
        priority: input.priority ?? settings?.defaultTaskPriority,
        completedAt: DONE_STATUSES.includes(status) ? new Date() : null,
        projectId,
        websiteId: access.websiteId,
        creatorId: userId,
      },
      select: taskSelect,
    });

    await logActivity(tx, {
      taskId: task.id,
      actorId: userId,
      type: TaskActivityType.CREATED,
      field: 'task',
      newValue: taskKey(task.number),
      changes: { title: task.title, key: taskKey(task.number) },
    });
    if (task.assignee) {
      await logActivity(tx, {
        taskId: task.id,
        actorId: userId,
        type: TaskActivityType.ASSIGNED,
        field: 'assignee',
        newValue: task.assignee.id,
        changes: { assignee: { from: null, to: task.assignee.name } },
      });
      await notify(tx, [task.assignee.id], {
        type: 'TASK_ASSIGNED',
        title: `You were assigned: ${task.title}`,
        actorId: userId,
        websiteId: access.websiteId,
        taskId: task.id,
        data: { projectId },
      });
    }
    await touchRead(tx, userId, task.id);
    return { ...task, key: taskKey(task.number), unreadCount: 0 };
  }).then((task) => {
    publishTaskEvent({ type: 'task.created', taskId: task.id, actorId: userId, message: (m) => `${m.actor} created ${m.key}: ${m.title}` });
    if (task.assignee) {
      publishTaskEvent({ type: 'task.assigned', taskId: task.id, actorId: userId, message: (m) => `${m.actor} assigned ${m.key} to ${m.assignee}` });
    }
    return task;
  });
};

const STATUS_WORD: Record<TaskStatus, string> = {
  OPEN: 'open',
  IN_PROGRESS: 'in progress',
  IN_REVIEW: 'under review',
  COMPLETED: 'completed',
  REOPENED: 'reopened',
  ARCHIVED: 'archived',
};

/** Real-time events for one update (after commit). */
const publishUpdate = (userId: string, taskId: string, before: { status: TaskStatus; assigneeId: string | null }, input: UpdateTaskInput) => {
  const statusChanged = Boolean(input.status && input.status !== before.status);
  const assigneeChanged = 'assigneeId' in input && (input.assigneeId ?? null) !== before.assigneeId;
  if (statusChanged) {
    const activity = activityForTransition(before.status, input.status!);
    const type: TaskEventType =
      activity === 'STARTED' ? 'task.started' : activity === 'COMPLETED' ? 'task.completed' : activity === 'REOPENED' ? 'task.reopened' : 'task.status_updated';
    const verb = { 'task.started': 'started', 'task.completed': 'completed', 'task.reopened': 'reopened' }[type as string];
    const to = STATUS_WORD[input.status!];
    publishTaskEvent({ type, taskId, actorId: userId, message: (m) => (verb ? `${m.actor} ${verb} ${m.key}` : `${m.actor} moved ${m.key} to ${to}`) });
  }
  if (assigneeChanged && input.assigneeId) {
    publishTaskEvent({
      type: 'task.assigned',
      taskId,
      actorId: userId,
      alsoPersonal: [before.assigneeId],
      message: (m) => `${m.actor} assigned ${m.key} to ${m.assignee}`,
    });
  }
  if (!statusChanged && !(assigneeChanged && input.assigneeId)) {
    publishTaskEvent({ type: 'task.updated', taskId, actorId: userId, message: (m) => `${m.actor} updated ${m.key}` });
  }
};

export type UpdateTaskInput = Partial<Omit<CreateTaskInput, 'metadata' | 'description' | 'pageUrl'>> & {
  description?: string | null;
  pageUrl?: string | null;
  metadata?: Record<string, unknown> | null;
};

const WORKFLOW_FIELDS = ['status', 'priority', 'assigneeId', 'dueDate'] as const;
const CONTENT_FIELDS = ['title', 'description', 'type', 'pageUrl', 'metadata', 'position'] as const;

type JsonScalar = string | number | boolean | null;
const normalise = (v: unknown): JsonScalar =>
  v instanceof Date ? v.toISOString() : v === undefined || v === null ? null : (v as JsonScalar);

/**
 * Updates a task. Content fields need edit rights (reporters: own task); workflow fields
 * (status, priority, assignee, due date) need task:manage (admins, managers, developers).
 * Each change is written to the activity log with its previous and new value.
 */
export const update = async (userId: string, taskId: string, input: UpdateTaskInput) => {
  const access = await getTaskAccess(userId, taskId);
  const touchesContent = CONTENT_FIELDS.some((f) => f in input);
  const touchesWorkflow = WORKFLOW_FIELDS.some((f) => f in input);
  if (touchesContent && !canOnTask(access, 'update')) throw forbidden();
  if (touchesWorkflow && !canManageTask(access)) {
    throw forbidden('Only developers and managers can change status, priority or assignee', 'WORKFLOW_FORBIDDEN');
  }

  return prisma.$transaction(async (tx) => {
    const before = await tx.task.findUniqueOrThrow({ where: { id: taskId } });
    if (input.assigneeId) {
      await assertAssignable(tx, input.assigneeId, { id: before.projectId, websiteId: before.websiteId });
    }
    if (input.status && input.status !== before.status && !isValidTransition(before.status, input.status)) {
      throw badRequest('Only completed or archived tasks can be reopened', 'INVALID_TRANSITION');
    }

    const data: Prisma.TaskUncheckedUpdateInput = {
      ...input,
      metadata: input.metadata === null ? Prisma.DbNull : (input.metadata as Prisma.InputJsonValue | undefined),
    };
    if (input.status && input.status !== before.status) {
      if (input.status === TaskStatus.COMPLETED) data.completedAt = new Date();
      else if (input.status !== TaskStatus.ARCHIVED) data.completedAt = null;
      data.archivedAt = input.status === TaskStatus.ARCHIVED ? new Date() : null;
    }

    const task = await tx.task.update({ where: { id: taskId }, data, select: taskSelect });

    // ── activity log ──
    const log = (a: Omit<ActivityInput, 'taskId' | 'actorId'>) => logActivity(tx, { taskId, actorId: userId, ...a });
    if (input.status && input.status !== before.status) {
      await log({
        type: activityForTransition(before.status, input.status),
        field: 'status',
        previousValue: before.status,
        newValue: input.status,
        changes: { status: { from: before.status, to: input.status } },
      });
    }
    if (input.priority && input.priority !== before.priority) {
      await log({
        type: TaskActivityType.PRIORITY_CHANGED,
        field: 'priority',
        previousValue: before.priority,
        newValue: input.priority,
        changes: { priority: { from: before.priority, to: input.priority } },
      });
    }
    if ('assigneeId' in input && (input.assigneeId ?? null) !== before.assigneeId) {
      const [fromName, toName] = await Promise.all([userName(tx, before.assigneeId), userName(tx, input.assigneeId)]);
      await log({
        type: input.assigneeId ? TaskActivityType.ASSIGNED : TaskActivityType.UNASSIGNED,
        field: 'assignee',
        previousValue: before.assigneeId,
        newValue: input.assigneeId ?? null,
        changes: { assignee: { from: fromName, to: toName } },
      });
    }
    const other: Record<string, { from: JsonScalar; to: JsonScalar }> = {};
    for (const f of ['title', 'description', 'type', 'pageUrl', 'dueDate'] as const) {
      if (!(f in input)) continue;
      const from = normalise(before[f]);
      const to = normalise(input[f]);
      if (from !== to) other[f] = { from, to };
    }
    const keys = Object.keys(other);
    if (keys.length === 1) {
      const f = keys[0]!;
      await log({ type: TaskActivityType.UPDATED, field: f, previousValue: other[f]!.from === null ? null : String(other[f]!.from), newValue: other[f]!.to === null ? null : String(other[f]!.to), changes: other as Prisma.InputJsonValue });
    } else if (keys.length > 1) {
      await log({ type: TaskActivityType.UPDATED, changes: other as Prisma.InputJsonValue });
    }

    // ── notifications ──
    if (input.assigneeId && input.assigneeId !== before.assigneeId) {
      await notify(tx, [input.assigneeId], {
        type: 'TASK_ASSIGNED',
        title: `You were assigned: ${task.title}`,
        actorId: userId,
        websiteId: task.websiteId,
        taskId,
        data: { projectId: task.projectId },
      });
    }
    if (input.status && input.status !== before.status) {
      await notify(tx, [before.creatorId, task.assignee?.id], {
        type: 'TASK_STATUS_CHANGED',
        title: `${taskKey(task.number)} ${task.title} is now ${input.status.replace('_', ' ').toLowerCase()}`,
        actorId: userId,
        websiteId: task.websiteId,
        taskId,
        data: { projectId: task.projectId, status: { from: before.status, to: input.status } },
      });
    }
    return { result: { ...task, key: taskKey(task.number) }, before: { status: before.status, assigneeId: before.assigneeId } };
  }).then(({ result, before }) => {
    publishUpdate(userId, taskId, before, input);
    return result;
  });
};

/** Restores an archived task to the status it had before it was archived. */
export const restore = async (userId: string, taskId: string) => {
  // Access first (404 for other tenants), so nothing about the task leaks.
  const access = await getTaskAccess(userId, taskId);
  if (!canManageTask(access)) throw forbidden('Only developers and managers can restore tasks', 'WORKFLOW_FORBIDDEN');
  const task = await prisma.task.findUnique({ where: { id: taskId }, select: { status: true } });
  if (!task) throw notFound('Task not found');
  if (task.status !== TaskStatus.ARCHIVED) throw badRequest('Task is not archived', 'NOT_ARCHIVED');
  const archivedEvent = await prisma.taskActivity.findFirst({
    where: { taskId, field: 'status', newValue: TaskStatus.ARCHIVED },
    orderBy: { createdAt: 'desc' },
    select: { previousValue: true },
  });
  const previous = archivedEvent?.previousValue as TaskStatus | undefined;
  const target = previous && previous !== TaskStatus.ARCHIVED && previous in TaskStatus ? previous : TaskStatus.OPEN;
  return update(userId, taskId, { status: target });
};

export const remove = async (userId: string, taskId: string) => {
  const access = await getTaskAccess(userId, taskId);
  if (!canOnTask(access, 'delete')) throw forbidden();
  const files = await prisma.taskAttachment.findMany({ where: { taskId }, select: { storageKey: true } });
  const snapshot = await taskSnapshot(taskId);
  await prisma.task.delete({ where: { id: taskId } });
  if (snapshot) publishTaskEvent({ type: 'task.deleted', taskId, actorId: userId, snapshot, message: (m) => `${m.actor} deleted ${m.key}` });
  await Promise.all(files.map((f) => deleteFile(f.storageKey).catch(() => undefined)));
};

// ───────────────────────────── Attachments ─────────────────────────────

const MAX_ATTACHMENTS_PER_TASK = 30;

/**
 * Adds a screenshot or file to a task, or to one of its comments (commentId).
 * Task files: the task's creator or anyone who manages tasks. Comment files: the comment's author.
 */
export const addAttachment = async (
  userId: string,
  taskId: string,
  input: { body: unknown; fileName: string; kind: AttachmentKind; commentId?: string },
) => {
  const access = await getTaskAccess(userId, taskId);
  if (input.commentId) {
    const comment = await prisma.taskComment.findUnique({ where: { id: input.commentId }, select: { taskId: true, authorId: true } });
    if (!comment || comment.taskId !== taskId) throw notFound('Comment not found');
    if (comment.authorId !== userId) throw forbidden('Only the author can attach files to a comment');
  } else if (!permissionsOf(access).upload) {
    throw forbidden('Only the reporter or the team can add files to this task');
  }

  const body = input.body;
  if (!Buffer.isBuffer(body) || body.length === 0) throw badRequest('Send the file as the request body', 'EMPTY_FILE');
  const detected = detectUpload(body, input.fileName);
  if (!detected) {
    throw badRequest('Unsupported file type. Allowed: images, PDF, ZIP, Office documents and plain text/CSV.', 'INVALID_FILE');
  }
  if (input.kind === AttachmentKind.SCREENSHOT && !detected.isImage) {
    throw badRequest('Screenshots must be PNG, JPEG, WebP or GIF images', 'INVALID_IMAGE');
  }
  if ((await prisma.taskAttachment.count({ where: { taskId } })) >= MAX_ATTACHMENTS_PER_TASK) {
    throw badRequest('This task already has the maximum number of files', 'TOO_MANY_FILES');
  }

  const storageKey = await saveFile(body, detected.ext);
  const fileName = safeFileName(input.fileName || `${input.kind === 'SCREENSHOT' ? 'screenshot' : 'file'}.${detected.ext}`, detected.ext);
  const attachment = await prisma.$transaction(async (tx) => {
    const a = await tx.taskAttachment.create({
      data: {
        taskId,
        commentId: input.commentId ?? null,
        uploaderId: userId,
        kind: input.kind,
        fileName,
        mimeType: detected.mime,
        sizeBytes: body.length,
        storageKey,
      },
      select: attachmentSelect,
    });
    await logActivity(tx, {
      taskId,
      actorId: userId,
      type: TaskActivityType.ATTACHMENT_ADDED,
      field: input.kind === 'SCREENSHOT' ? 'screenshot' : 'file',
      newValue: fileName,
      changes: { attachmentId: a.id, fileName, kind: input.kind, ...(input.commentId ? { commentId: input.commentId } : {}) },
    });
    return a;
  });
  publishTaskEvent({ type: 'task.updated', taskId, actorId: userId, message: (m) => `${m.actor} added a file to ${m.key}` });
  return withUrl(attachment);
};

export const removeAttachment = async (userId: string, taskId: string, attachmentId: string) => {
  const access = await getTaskAccess(userId, taskId);
  const a = await prisma.taskAttachment.findUnique({ where: { id: attachmentId } });
  if (!a || a.taskId !== taskId) throw notFound('File not found');
  if (a.uploaderId !== userId && access.role !== ProjectRole.MANAGER) throw forbidden();
  await prisma.$transaction([
    prisma.taskAttachment.delete({ where: { id: attachmentId } }),
    prisma.taskActivity.create({
      data: {
        taskId,
        actorId: userId,
        type: TaskActivityType.ATTACHMENT_REMOVED,
        field: a.kind === 'SCREENSHOT' ? 'screenshot' : 'file',
        previousValue: a.fileName,
        changes: { fileName: a.fileName },
      },
    }),
  ]);
  await deleteFile(a.storageKey).catch(() => undefined);
  publishTaskEvent({ type: 'task.updated', taskId, actorId: userId, message: (m) => `${m.actor} removed a file from ${m.key}` });
};

export const uploadLimitBytes = () => env.MAX_UPLOAD_MB * 1024 * 1024;
