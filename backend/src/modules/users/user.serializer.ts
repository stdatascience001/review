import type { Prisma } from '@prisma/client';

/** Fields safe to expose for *other* users (members, assignees, comment authors…). */
export const publicUserSelect = {
  id: true,
  name: true,
  email: true,
  avatarUrl: true,
} satisfies Prisma.UserSelect;

/** Fields loaded to build the current user's own profile. Never includes passwordHash. */
export const selfUserSelect = {
  id: true,
  email: true,
  name: true,
  avatarUrl: true,
  role: true,
  status: true,
  emailVerifiedAt: true,
  googleId: true,
  passwordHash: true, // only used to compute `hasPassword`; stripped by toSelfProfile
  lastLoginAt: true,
  createdAt: true,
  updatedAt: true,
} satisfies Prisma.UserSelect;

type SelfUserRow = Prisma.UserGetPayload<{ select: typeof selfUserSelect }>;

export const toSelfProfile = (u: SelfUserRow) => ({
  id: u.id,
  email: u.email,
  name: u.name,
  avatarUrl: u.avatarUrl,
  role: u.role,
  status: u.status,
  emailVerified: Boolean(u.emailVerifiedAt),
  emailVerifiedAt: u.emailVerifiedAt,
  hasPassword: Boolean(u.passwordHash),
  googleLinked: Boolean(u.googleId),
  lastLoginAt: u.lastLoginAt,
  createdAt: u.createdAt,
  updatedAt: u.updatedAt,
});

export type SelfProfile = ReturnType<typeof toSelfProfile>;
