import { z } from 'zod';
import { TaskPriority, TaskStatus, TaskType } from '@prisma/client';
import { emailSchema, passwordSchema } from '../auth/auth.schemas';
import { paginationQuery } from '../../lib/pagination';

export const siteIdSchema = z
  .string()
  .trim()
  .regex(/^site_[a-f0-9]{20}$/, 'Invalid Site ID');

export const configQuery = z.object({ siteId: siteIdSchema });

export const loginBody = z.object({
  siteId: siteIdSchema,
  email: emailSchema,
  password: z.string().min(1).max(256),
});

export const registerBody = z.object({
  siteId: siteIdSchema,
  name: z.string().trim().min(1).max(120),
  email: emailSchema,
  password: passwordSchema,
});

export const forgotPasswordBody = z.object({ siteId: siteIdSchema, email: emailSchema });

export const refreshBody = z.object({ siteId: siteIdSchema, refreshToken: z.string().min(20).max(200) });

export const googleStartQuery = z.object({
  siteId: siteIdSchema,
  origin: z.string().url().max(300),
});

export const TABS = ['all', 'open', 'in_progress', 'done', 'archived'] as const;
export type Tab = (typeof TABS)[number];

const httpUrl = z
  .string()
  .trim()
  .url()
  .max(2048)
  .refine((v) => /^https?:\/\//i.test(v), 'Must be an http(s) URL');

export const listTasksQuery = paginationQuery.extend({
  tab: z.enum(TABS).default('all'),
  /** When set, only tasks reported on this page (query string and hash ignored). */
  pageUrl: httpUrl.optional(),
  mine: z
    .enum(['true', 'false'])
    .optional()
    .transform((v) => v === 'true'),
  q: z.string().trim().max(200).optional(),
  pageSize: z.coerce.number().int().min(1).max(50).default(20),
});

export const taskIdParams = z.object({ taskId: z.string().uuid() });

const finite = z.number().finite();
/**
 * Where on the page a comment points: a CSS selector (unique when captured), the element's
 * tag and visible text (to re-find it when the page changes), and its position in the
 * document (last-resort fallback). Displayed as plain text only.
 */
export const elementAnchor = z.object({
  selector: z.string().trim().min(1).max(1_000),
  tag: z.string().trim().toLowerCase().regex(/^[a-z][a-z0-9-]{0,31}$/, 'Invalid tag'),
  text: z.string().max(200).optional(),
  rect: z
    .object({ x: finite, y: finite, width: finite.min(0), height: finite.min(0) })
    .optional(),
  viewportWidth: z.number().int().positive().max(100_000).optional(),
});
export type ElementAnchor = z.infer<typeof elementAnchor>;

export const createTaskBody = z.object({
  title: z.string().trim().min(1).max(255),
  description: z.string().trim().max(20_000).optional(),
  type: z.nativeEnum(TaskType).default('OTHER'),
  priority: z.nativeEnum(TaskPriority).optional(),
  projectId: z.string().uuid().optional(),
  pageUrl: httpUrl,
  pageTitle: z.string().trim().max(300).optional(),
  /** The page element the comment is about (picked in the widget's "Add a Comment" mode). */
  element: elementAnchor.optional(),
  /** Capture context: viewport, screen, user agent, scroll position… */
  context: z
    .record(z.unknown())
    .refine((v) => JSON.stringify(v).length <= 4_000, 'context is too large')
    .optional(),
});

const commentText = z.string().trim().min(1, 'Comment cannot be empty').max(10_000);
export const commentBody = z.object({ body: commentText, parentId: z.string().uuid().optional() });
export const editCommentBody = z.object({ body: commentText });
export const commentIdParams = z.object({ commentId: z.string().uuid() });
export const attachmentParams = taskIdParams.extend({ attachmentId: z.string().uuid() });

/** Reporters may edit content of their own task; the workflow fields need task:manage (checked in the service). */
export const updateTaskBody = z
  .object({
    title: z.string().trim().min(1).max(255).optional(),
    description: z.string().trim().max(20_000).nullable().optional(),
    type: z.nativeEnum(TaskType).optional(),
    status: z.nativeEnum(TaskStatus).optional(),
    priority: z.nativeEnum(TaskPriority).optional(),
    assigneeId: z.string().uuid().nullable().optional(),
  })
  .refine((v) => Object.keys(v).length > 0, 'Provide at least one field to update');

export const commentsQuery = paginationQuery.extend({
  pageSize: z.coerce.number().int().min(1).max(100).default(100),
});
