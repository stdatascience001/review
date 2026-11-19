import express, { Router } from 'express';
import { audit } from '../../lib/audit';
import { env } from '../../config/env';
import { authenticate, authOf, requireVerifiedEmail } from '../../middleware/authenticate';
import { paramsOf, validate } from '../../middleware/validate';
import * as comments from '../comments/comments.controller';
import * as cs from '../comments/comments.schemas';
import { reviewLink } from '../widget/widget.service';
import * as c from './tasks.controller';
import * as s from './tasks.schemas';

export const tasksRoutes = () => {
  const r = Router();
  r.use(authenticate, requireVerifiedEmail);

  r.get('/', validate({ query: s.listAllTasksQuery }), c.listAll);
  r.post('/', validate({ body: s.createTaskWithProjectBody }), c.createAnywhere);
  r.get('/:taskId', validate({ params: s.taskIdParams }), c.get);
  r.patch('/:taskId', validate({ params: s.taskIdParams, body: s.updateTaskBody }), c.update);
  r.delete('/:taskId', validate({ params: s.taskIdParams }), audit('task.deleted', { target: { type: 'task', param: 'taskId' } }), c.remove);
  r.get('/:taskId/activity', validate({ params: s.taskIdParams, query: s.activityQuery }), c.activity);
  r.get('/:taskId/assignees', validate({ params: s.taskIdParams }), c.assignees);
  r.post('/:taskId/restore', validate({ params: s.taskIdParams }), c.restore);
  r.post('/:taskId/read', validate({ params: s.taskIdParams }), c.markRead);
  // "Show on page": the page link with a one-time widget sign-in (no second login on the website).
  r.post('/:taskId/review-link', validate({ params: s.taskIdParams }), async (req, res) => {
    res.json({ data: await reviewLink(authOf(req).userId, paramsOf(req, s.taskIdParams).taskId) });
  });
  r.post(
    '/:taskId/attachments',
    validate({ params: s.taskIdParams, query: s.uploadQuery }),
    express.raw({ type: () => true, limit: `${env.MAX_UPLOAD_MB}mb` }),
    c.upload,
  );
  r.delete('/:taskId/attachments/:attachmentId', validate({ params: s.attachmentParams }), c.removeAttachment);

  // Nested collection: comments of a task
  r.get('/:taskId/comments', validate({ params: s.taskIdParams, query: cs.listCommentsQuery }), comments.list);
  r.post('/:taskId/comments', validate({ params: s.taskIdParams, body: cs.createCommentBody }), comments.create);

  return r;
};
