import { z } from 'zod';
import { TaskPriority, TaskStatus, TaskType } from '@prisma/client';
import { paginationQuery } from '../../lib/pagination';

export const taskIdParams = z.object({ taskId: z.string().uuid() });

const csvEnum = <T extends Record<string, string>>(e: T) =>
  z
    .union([z.nativeEnum(e), z.array(z.nativeEnum(e)), z.string()])
    .optional()
    .transform((v, ctx) => {
      if (v === undefined) return undefined;
      const values = (Array.isArray(v) ? v : String(v).split(',')).map((x) => x.trim()).filter(Boolean);
      const allowed = Object.values(e);
      const bad = values.filter((x) => !allowed.includes(x));
      if (bad.length) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: `Invalid value(s): ${bad.join(', ')}` });
        return z.NEVER;
      }
      return values as T[keyof T][];
    });

export const listTasksQuery = paginationQuery.extend({
  status: csvEnum(TaskStatus),
  priority: csvEnum(TaskPriority),
  type: csvEnum(TaskType),
  assigneeId: z.union([z.string().uuid(), z.literal('me'), z.literal('none')]).optional(),
  q: z.string().trim().max(200).optional(),
  sort: z.enum(['position', 'createdAt', 'updatedAt', 'dueDate', 'priority', 'number']).default('position'),
  order: z.enum(['asc', 'desc']).default('asc'),
});

const pageUrl = z
  .string()
  .trim()
  .url()
  .max(2048)
  .refine((v) => /^https?:\/\//i.test(v), 'pageUrl must be http(s)');

/** Free-form capture metadata (viewport, browser, selector, pin coordinates…); size-capped. */
const metadata = z
  .record(z.unknown())
  .refine((v) => JSON.stringify(v).length <= 10_000, 'metadata is too large (max 10KB)');

export const createTaskBody = z.object({
  title: z.string().trim().min(1).max(255),
  description: z.string().max(20_000).optional(),
  status: z.nativeEnum(TaskStatus).optional(),
  priority: z.nativeEnum(TaskPriority).optional(),
  type: z.nativeEnum(TaskType).optional(),
  pageUrl: pageUrl.optional(),
  metadata: metadata.optional(),
  assigneeId: z.string().uuid().nullable().optional(),
  dueDate: z.coerce.date().nullable().optional(),
  position: z.number().int().min(0).max(1_000_000_000).optional(),
});

export const updateTaskBody = z
  .object({
    title: z.string().trim().min(1).max(255).optional(),
    description: z.string().max(20_000).nullable().optional(),
    status: z.nativeEnum(TaskStatus).optional(),
    priority: z.nativeEnum(TaskPriority).optional(),
    type: z.nativeEnum(TaskType).optional(),
    pageUrl: pageUrl.nullable().optional(),
    metadata: metadata.nullable().optional(),
    assigneeId: z.string().uuid().nullable().optional(),
    dueDate: z.coerce.date().nullable().optional(),
    position: z.number().int().min(0).max(1_000_000_000).optional(),
  })
  .refine((v) => Object.keys(v).length > 0, 'Provide at least one field to update');

export const activityQuery = paginationQuery.extend({
  pageSize: z.coerce.number().int().min(1).max(100).default(50),
});

/** GET /tasks — tasks across every project the user can access ("All Tasks" / "My Tasks"). */
export const listAllTasksQuery = listTasksQuery.extend({
  scope: z.enum(['all', 'mine', 'created']).default('all'),
  websiteId: z.string().uuid().optional(),
  projectId: z.string().uuid().optional(),
  overdue: z
    .enum(['true', 'false'])
    .optional()
    .transform((v) => v === 'true'),
  sort: z.enum(['position', 'createdAt', 'updatedAt', 'dueDate', 'priority', 'number']).default('createdAt'),
  order: z.enum(['asc', 'desc']).default('desc'),
});

/** POST /tasks — project chosen in the body. */
export const createTaskWithProjectBody = createTaskBody.extend({ projectId: z.string().uuid() });

export const attachmentParams = taskIdParams.extend({ attachmentId: z.string().uuid() });

/** POST /tasks/:taskId/attachments — raw file body; name in the X-File-Name header (URI-encoded). */
export const uploadQuery = z.object({
  kind: z
    .enum(['screenshot', 'file'])
    .default('file')
    .transform((k) => (k === 'screenshot' ? ('SCREENSHOT' as const) : ('FILE' as const))),
  commentId: z.string().uuid().optional(),
});

export const fileNameOf = (header: string | undefined) => {
  if (!header) return '';
  try {
    return decodeURIComponent(header).slice(0, 255);
  } catch {
    return header.slice(0, 255);
  }
};
