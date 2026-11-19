import { TaskActivityType, type Prisma } from '@prisma/client';
import { badRequest, forbidden, notFound } from '../../lib/errors';
import { paginated, toSkipTake, type Pagination } from '../../lib/pagination';
import { prisma } from '../../lib/prisma';
import { accessibleTaskWhere, getTaskAccess, projectCan } from '../access/access.service';
import { notify } from '../notifications/notifications.service';
import { lastReadAt, logActivity, withUrl } from '../tasks/tasks.service';
import { deleteFile } from '../../lib/storage';
import { publishTaskEvent } from '../../lib/realtime';
import { publicUserSelect } from '../users/user.serializer';

const commentSelect = {
  id: true,
  taskId: true,
  parentId: true,
  body: true,
  editedAt: true,
  createdAt: true,
  updatedAt: true,
  author: { select: publicUserSelect },
  attachments: {
    select: {
      id: true,
      kind: true,
      fileName: true,
      mimeType: true,
      sizeBytes: true,
      commentId: true,
      createdAt: true,
      uploader: { select: publicUserSelect },
    },
    orderBy: { createdAt: 'asc' },
  },
  _count: { select: { replies: true } },
} satisfies Prisma.TaskCommentSelect;

type CommentRow = Prisma.TaskCommentGetPayload<{ select: typeof commentSelect }>;
const serialize = (c: CommentRow, userId: string, readAt: Date | null) => ({
  ...c,
  attachments: c.attachments.map(withUrl),
  /** Posted by someone else since the user last opened the task (unread indicator). */
  isNew: c.author?.id !== userId && (!readAt || c.createdAt > readAt),
});

/**
 * Chronological (oldest first), so clients render the conversation top-to-bottom; replies
 * carry parentId. Each comment says whether it's new to this user; reading doesn't mark the
 * task as read (POST /tasks/:id/read does), so a client can highlight new ones first.
 */
export const list = async (userId: string, taskId: string, query: Pagination) => {
  await getTaskAccess(userId, taskId);
  const where = { taskId };
  const [items, total, readAt] = await Promise.all([
    prisma.taskComment.findMany({ where, select: commentSelect, orderBy: { createdAt: 'asc' }, ...toSkipTake(query) }),
    prisma.taskComment.count({ where }),
    lastReadAt(userId, taskId),
  ]);
  return { ...paginated(items.map((c) => serialize(c, userId, readAt)), total, query), lastReadAt: readAt };
};

export const create = async (userId: string, taskId: string, input: { body: string; parentId?: string }) => {
  const access = await getTaskAccess(userId, taskId);
  if (!projectCan(access.role, 'comment:create')) throw forbidden();

  if (input.parentId) {
    const parent = await prisma.taskComment.findUnique({ where: { id: input.parentId } });
    if (!parent || parent.taskId !== taskId) throw badRequest('Parent comment not found on this task', 'INVALID_PARENT');
    // Threads are one level deep: replying to a reply attaches to its root comment.
    if (parent.parentId) input.parentId = parent.parentId;
  }

  let parentAuthorId: string | null = null;
  const created = await prisma.$transaction(async (tx) => {
    const comment = await tx.taskComment.create({
      data: { taskId, authorId: userId, body: input.body, parentId: input.parentId },
      select: commentSelect,
    });
    await logActivity(tx, {
      taskId,
      actorId: userId,
      type: TaskActivityType.COMMENTED,
      field: 'comment',
      newValue: input.body.slice(0, 500),
      changes: { commentId: comment.id, ...(input.parentId ? { parentId: input.parentId } : {}) },
    });
    // Writing a comment means you've seen the conversation so far.
    await tx.taskRead.upsert({
      where: { taskId_userId: { taskId, userId } },
      create: { taskId, userId },
      update: { lastReadAt: new Date() },
    });

    const task = await tx.task.findUniqueOrThrow({
      where: { id: taskId },
      select: { title: true, creatorId: true, assigneeId: true, websiteId: true, projectId: true },
    });
    const parentAuthor = input.parentId
      ? (await tx.taskComment.findUnique({ where: { id: input.parentId }, select: { authorId: true } }))?.authorId
      : null;
    parentAuthorId = parentAuthor ?? null;
    await notify(tx, [task.creatorId, task.assigneeId, parentAuthor], {
      type: 'TASK_COMMENTED',
      title: `New comment on ${task.title}`,
      body: input.body.slice(0, 280),
      actorId: userId,
      websiteId: task.websiteId,
      taskId,
      data: { projectId: task.projectId, commentId: comment.id },
    });
    return serialize(comment, userId, new Date());
  });
  publishTaskEvent(
    input.parentId
      ? {
          type: 'comment.reply',
          taskId,
          actorId: userId,
          commentId: created.id,
          alsoPersonal: [parentAuthorId],
          message: (m) => `${m.actor} replied on ${m.key}: “${input.body.slice(0, 80)}”`,
        }
      : {
          type: 'comment.created',
          taskId,
          actorId: userId,
          commentId: created.id,
          message: (m) => `${m.actor} commented on ${m.key}: “${input.body.slice(0, 80)}”`,
        },
  );
  return created;
};

const loadForMutation = async (userId: string, commentId: string) => {
  const comment = await prisma.taskComment.findUnique({ where: { id: commentId } });
  if (!comment) throw notFound('Comment not found');
  // Throws 404 if the user cannot access the comment's task (tenant isolation).
  const access = await getTaskAccess(userId, comment.taskId).catch(() => {
    throw notFound('Comment not found');
  });
  return { comment, access };
};

export const update = async (userId: string, commentId: string, body: string) => {
  const { comment } = await loadForMutation(userId, commentId);
  if (comment.authorId !== userId) throw forbidden('Only the author can edit a comment');
  const updated = await prisma.$transaction(async (tx) => {
    const c = await tx.taskComment.update({ where: { id: commentId }, data: { body, editedAt: new Date() }, select: commentSelect });
    await logActivity(tx, {
      taskId: comment.taskId,
      actorId: userId,
      type: TaskActivityType.COMMENT_EDITED,
      field: 'comment',
      previousValue: comment.body.slice(0, 500),
      newValue: body.slice(0, 500),
      changes: { commentId },
    });
    return c;
  });
  publishTaskEvent({ type: 'task.updated', taskId: comment.taskId, actorId: userId, message: (m) => `${m.actor} edited a comment on ${m.key}` });
  return serialize(updated, userId, new Date());
};

export const remove = async (userId: string, commentId: string) => {
  const { comment, access } = await loadForMutation(userId, commentId);
  if (comment.authorId !== userId && !projectCan(access.role, 'comment:delete:any')) throw forbidden();
  // The comment, its replies, and the files attached to any of them.
  const ids = [commentId, ...(await prisma.taskComment.findMany({ where: { parentId: commentId }, select: { id: true } })).map((r) => r.id)];
  const files = await prisma.taskAttachment.findMany({ where: { commentId: { in: ids } }, select: { storageKey: true } });
  await prisma.$transaction([
    prisma.taskAttachment.deleteMany({ where: { commentId: { in: ids } } }),
    prisma.taskComment.delete({ where: { id: commentId } }),
    prisma.taskActivity.create({
      data: {
        taskId: comment.taskId,
        actorId: userId,
        type: TaskActivityType.COMMENT_DELETED,
        field: 'comment',
        previousValue: comment.body.slice(0, 500),
        changes: { commentId, replies: ids.length - 1 },
      },
    }),
  ]);
  await Promise.all(files.map((f) => deleteFile(f.storageKey).catch(() => undefined)));
  publishTaskEvent({ type: 'task.updated', taskId: comment.taskId, actorId: userId, message: (m) => `${m.actor} deleted a comment on ${m.key}` });
};

/** Recent comments across every task the user can access (newest first). */
export const listAll = async (
  userId: string,
  query: Pagination & { websiteId?: string; projectId?: string; q?: string; mine?: boolean },
) => {
  const where: Prisma.TaskCommentWhereInput = {
    task: {
      AND: [
        await accessibleTaskWhere(userId),
        query.websiteId ? { websiteId: query.websiteId } : {},
        query.projectId ? { projectId: query.projectId } : {},
      ],
    },
    ...(query.mine ? { authorId: userId } : {}),
    ...(query.q ? { body: { contains: query.q, mode: 'insensitive' } } : {}),
  };
  const [items, total] = await prisma.$transaction([
    prisma.taskComment.findMany({
      where,
      select: {
        ...commentSelect,
        task: {
          select: {
            id: true,
            number: true,
            title: true,
            status: true,
            project: { select: { id: true, name: true } },
            website: { select: { id: true, name: true } },
          },
        },
      },
      orderBy: { createdAt: 'desc' },
      ...toSkipTake(query),
    }),
    prisma.taskComment.count({ where }),
  ]);
  return paginated(items, total, query);
};
