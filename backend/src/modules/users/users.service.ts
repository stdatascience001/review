import type { Prisma, UserRole, UserStatus } from '@prisma/client';
import { badRequest } from '../../lib/errors';
import { paginated, toSkipTake, type Pagination } from '../../lib/pagination';
import { prisma } from '../../lib/prisma';
import { revokeAllSessions } from '../auth/session.service';
import { selfUserSelect, toSelfProfile } from './user.serializer';

export const getMe = async (userId: string) =>
  toSelfProfile(await prisma.user.findUniqueOrThrow({ where: { id: userId }, select: selfUserSelect }));

export const updateMe = async (userId: string, data: { name?: string; avatarUrl?: string | null }) =>
  toSelfProfile(await prisma.user.update({ where: { id: userId }, data, select: selfUserSelect }));

// ───────────────────────────── Platform admin ─────────────────────────────

const adminUserSelect = {
  id: true,
  email: true,
  name: true,
  avatarUrl: true,
  role: true,
  status: true,
  emailVerifiedAt: true,
  lastLoginAt: true,
  createdAt: true,
  _count: { select: { websiteMemberships: true } },
} satisfies Prisma.UserSelect;

export const listUsers = async (
  query: Pagination & { q?: string; role?: UserRole; status?: UserStatus },
) => {
  const where: Prisma.UserWhereInput = {
    role: query.role,
    status: query.status,
    ...(query.q
      ? {
          OR: [
            { email: { contains: query.q, mode: 'insensitive' } },
            { name: { contains: query.q, mode: 'insensitive' } },
          ],
        }
      : {}),
  };
  const [items, total] = await prisma.$transaction([
    prisma.user.findMany({ where, select: adminUserSelect, orderBy: { createdAt: 'desc' }, ...toSkipTake(query) }),
    prisma.user.count({ where }),
  ]);
  return paginated(items, total, query);
};

export const getUser = (userId: string) =>
  prisma.user.findUniqueOrThrow({ where: { id: userId }, select: adminUserSelect });

export const adminUpdateUser = async (
  actorId: string,
  userId: string,
  data: { role?: UserRole; status?: UserStatus },
) => {
  if (actorId === userId) throw badRequest('You cannot change your own role or status', 'SELF_MODIFICATION');
  const user = await prisma.user.update({ where: { id: userId }, data, select: adminUserSelect });
  if (data.status === 'SUSPENDED') await revokeAllSessions(userId);
  return user;
};
