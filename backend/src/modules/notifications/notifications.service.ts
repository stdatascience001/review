import type { NotificationType, Prisma } from '@prisma/client';
import { notFound } from '../../lib/errors';
import { paginated, toSkipTake, type Pagination } from '../../lib/pagination';
import { prisma, type Tx } from '../../lib/prisma';
import { publicUserSelect } from '../users/user.serializer';

export interface NotifyInput {
  type: NotificationType;
  title: string;
  body?: string;
  actorId?: string | null;
  websiteId?: string | null;
  taskId?: string | null;
  data?: Prisma.InputJsonValue;
}

/** Creates one notification per recipient, skipping the actor and duplicates. */
export const notify = async (db: Tx | typeof prisma, recipients: (string | null | undefined)[], input: NotifyInput) => {
  const userIds = [...new Set(recipients.filter((id): id is string => Boolean(id)))].filter(
    (id) => id !== input.actorId,
  );
  if (userIds.length === 0) return;
  await db.notification.createMany({
    data: userIds.map((userId) => ({
      userId,
      type: input.type,
      title: input.title.slice(0, 255),
      body: input.body?.slice(0, 2000),
      actorId: input.actorId ?? null,
      websiteId: input.websiteId ?? null,
      taskId: input.taskId ?? null,
      data: input.data,
    })),
  });
};

// Every query below is scoped to the requesting user's id — users can only ever see their own notifications.

export const list = async (userId: string, query: Pagination & { unreadOnly?: boolean }) => {
  const where: Prisma.NotificationWhereInput = { userId, ...(query.unreadOnly ? { readAt: null } : {}) };
  const [items, total] = await prisma.$transaction([
    prisma.notification.findMany({
      where,
      include: { actor: { select: publicUserSelect } },
      orderBy: { createdAt: 'desc' },
      ...toSkipTake(query),
    }),
    prisma.notification.count({ where }),
  ]);
  return paginated(items, total, query);
};

export const unreadCount = (userId: string) => prisma.notification.count({ where: { userId, readAt: null } });

export const markRead = async (userId: string, notificationId: string) => {
  const result = await prisma.notification.updateMany({
    where: { id: notificationId, userId },
    data: { readAt: new Date() },
  });
  if (result.count === 0) throw notFound('Notification not found');
};

export const markAllRead = async (userId: string) => {
  const result = await prisma.notification.updateMany({ where: { userId, readAt: null }, data: { readAt: new Date() } });
  return result.count;
};

export const remove = async (userId: string, notificationId: string) => {
  const result = await prisma.notification.deleteMany({ where: { id: notificationId, userId } });
  if (result.count === 0) throw notFound('Notification not found');
};
