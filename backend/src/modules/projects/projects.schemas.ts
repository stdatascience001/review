import { z } from 'zod';
import { ProjectRole, ProjectStatus } from '@prisma/client';
import { paginationQuery } from '../../lib/pagination';

const dateOnly = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD')
  .transform((v) => new Date(`${v}T00:00:00.000Z`));

export const projectIdParams = z.object({ projectId: z.string().uuid() });
export const projectMemberParams = projectIdParams.extend({ userId: z.string().uuid() });

export const listProjectsQuery = paginationQuery.extend({
  status: z.nativeEnum(ProjectStatus).optional(),
  q: z.string().trim().max(200).optional(),
});

export const listAllProjectsQuery = listProjectsQuery.extend({
  websiteId: z.string().uuid().optional(),
  pageSize: z.coerce.number().int().min(1).max(200).default(20),
});

const datesInOrder = (v: { startDate?: Date | null; dueDate?: Date | null }) =>
  !v.startDate || !v.dueDate || v.dueDate >= v.startDate;

const projectFields = {
  name: z.string().trim().min(1).max(120),
  description: z.string().trim().max(5000).optional(),
  status: z.nativeEnum(ProjectStatus).optional(),
  startDate: dateOnly.optional(),
  dueDate: dateOnly.optional(),
  memberIds: z.array(z.string().uuid()).max(200).optional(),
};

export const createProjectBody = z
  .object(projectFields)
  .refine(datesInOrder, { message: 'Deadline must be on or after the start date', path: ['dueDate'] });

/** POST /projects — the website is chosen in the body ("Assign Website"). */
export const createProjectWithWebsiteBody = z
  .object({ ...projectFields, websiteId: z.string().uuid() })
  .refine(datesInOrder, { message: 'Deadline must be on or after the start date', path: ['dueDate'] });

export const updateProjectBody = z
  .object({
    name: z.string().trim().min(1).max(120).optional(),
    description: z.string().trim().max(5000).nullable().optional(),
    status: z.nativeEnum(ProjectStatus).optional(),
    startDate: dateOnly.nullable().optional(),
    dueDate: dateOnly.nullable().optional(),
  })
  .refine((v) => Object.keys(v).length > 0, 'Provide at least one field to update')
  .refine(datesInOrder, { message: 'Deadline must be on or after the start date', path: ['dueDate'] });

export const addProjectMemberBody = z.object({
  userId: z.string().uuid(),
  role: z.nativeEnum(ProjectRole).optional(),
});

export const updateProjectMemberBody = z.object({ role: z.nativeEnum(ProjectRole) });
