import { z } from 'zod';
import { UserRole, UserStatus } from '@prisma/client';
import { nameSchema, passwordSchema } from '../auth/auth.schemas';
import { paginationQuery } from '../../lib/pagination';

export const updateMeBody = z
  .object({
    name: nameSchema.optional(),
    avatarUrl: z.string().trim().url().max(2048).startsWith('https://', 'Avatar URL must use https').nullable().optional(),
  })
  .refine((v) => Object.keys(v).length > 0, 'Provide at least one field to update');

export const changePasswordBody = z.object({
  currentPassword: z.string().max(128).optional(),
  newPassword: passwordSchema,
});

export const userIdParams = z.object({ userId: z.string().uuid() });

export const listUsersQuery = paginationQuery.extend({
  q: z.string().trim().max(200).optional(),
  role: z.nativeEnum(UserRole).optional(),
  status: z.nativeEnum(UserStatus).optional(),
});

export const adminUpdateUserBody = z
  .object({
    role: z.nativeEnum(UserRole).optional(),
    status: z.nativeEnum(UserStatus).optional(),
  })
  .refine((v) => v.role !== undefined || v.status !== undefined, 'Provide role or status');
