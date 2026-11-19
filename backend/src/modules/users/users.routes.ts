import { Router } from 'express';
import { audit } from '../../lib/audit';
import { authenticate, requireRole } from '../../middleware/authenticate';
import { validate } from '../../middleware/validate';
import * as c from './users.controller';
import * as s from './users.schemas';

export const usersRoutes = () => {
  const r = Router();
  r.use(authenticate);

  // Current user
  r.get('/me', c.getMe);
  r.patch('/me', validate({ body: s.updateMeBody }), c.updateMe);
  r.patch('/me/password', validate({ body: s.changePasswordBody }), audit('user.password_changed'), c.changeMyPassword);

  // Platform administration
  r.get('/', requireRole('SUPER_ADMIN'), validate({ query: s.listUsersQuery }), c.listUsers);
  r.get('/:userId', requireRole('SUPER_ADMIN'), validate({ params: s.userIdParams }), c.getUser);
  r.patch(
    '/:userId',
    audit('admin.user_updated', { target: { type: 'user', param: 'userId' }, meta: (req) => ({ changes: req.body }) }),
    requireRole('SUPER_ADMIN'),
    validate({ params: s.userIdParams, body: s.adminUpdateUserBody }),
    c.updateUser,
  );

  return r;
};
