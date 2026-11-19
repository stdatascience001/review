import { Router } from 'express';
import { authenticate, requireVerifiedEmail } from '../../middleware/authenticate';
import { validate } from '../../middleware/validate';
import * as c from './comments.controller';
import * as s from './comments.schemas';

export const commentsRoutes = () => {
  const r = Router();
  r.use(authenticate, requireVerifiedEmail);
  r.get('/', validate({ query: s.listAllCommentsQuery }), c.listAll);
  r.patch('/:commentId', validate({ params: s.commentIdParams, body: s.updateCommentBody }), c.update);
  r.delete('/:commentId', validate({ params: s.commentIdParams }), c.remove);
  return r;
};
