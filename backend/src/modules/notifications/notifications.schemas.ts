import { z } from 'zod';
import { paginationQuery } from '../../lib/pagination';

export const listNotificationsQuery = paginationQuery.extend({
  unreadOnly: z
    .enum(['true', 'false'])
    .optional()
    .transform((v) => v === 'true'),
});

export const notificationIdParams = z.object({ notificationId: z.string().uuid() });
