import { z } from 'zod';
import { paginationQuery } from '../../lib/pagination';

export const commentIdParams = z.object({ commentId: z.string().uuid() });

export const listCommentsQuery = paginationQuery.extend({
  pageSize: z.coerce.number().int().min(1).max(100).default(50),
});

const body = z.string().trim().min(1, 'Comment cannot be empty').max(10_000);

export const createCommentBody = z.object({
  body,
  parentId: z.string().uuid().optional(),
});

export const updateCommentBody = z.object({ body });

export const listAllCommentsQuery = paginationQuery.extend({
  websiteId: z.string().uuid().optional(),
  projectId: z.string().uuid().optional(),
  q: z.string().trim().max(200).optional(),
  mine: z
    .enum(['true', 'false'])
    .optional()
    .transform((v) => v === 'true'),
});
