import { Router } from 'express';
import { authenticate } from '../../middleware/authenticate';
import { validate } from '../../middleware/validate';
import * as c from './notifications.controller';
import * as s from './notifications.schemas';

export const notificationsRoutes = () => {
  const r = Router();
  r.use(authenticate);
  r.get('/', validate({ query: s.listNotificationsQuery }), c.list);
  r.get('/unread-count', c.unreadCount);
  r.post('/read-all', c.markAllRead);
  r.patch('/:notificationId/read', validate({ params: s.notificationIdParams }), c.markRead);
  r.delete('/:notificationId', validate({ params: s.notificationIdParams }), c.remove);
  return r;
};
