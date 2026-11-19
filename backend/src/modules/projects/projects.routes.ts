import { Router } from 'express';
import { audit } from '../../lib/audit';
import { authenticate, requireVerifiedEmail } from '../../middleware/authenticate';
import { validate } from '../../middleware/validate';
import * as tasks from '../tasks/tasks.controller';
import * as ts from '../tasks/tasks.schemas';
import * as c from './projects.controller';
import * as s from './projects.schemas';

export const projectsRoutes = () => {
  const r = Router();
  r.use(authenticate, requireVerifiedEmail);

  r.get('/', validate({ query: s.listAllProjectsQuery }), c.listAll);
  r.post('/', validate({ body: s.createProjectWithWebsiteBody }), c.create);
  r.get('/:projectId', validate({ params: s.projectIdParams }), c.get);
  r.patch('/:projectId', validate({ params: s.projectIdParams, body: s.updateProjectBody }), c.update);
  r.delete('/:projectId', validate({ params: s.projectIdParams }), audit('project.deleted', { target: { type: 'project', param: 'projectId' } }), c.remove);

  r.get('/:projectId/members', validate({ params: s.projectIdParams }), c.listMembers);
  r.post('/:projectId/members', validate({ params: s.projectIdParams, body: s.addProjectMemberBody }), c.addMember);
  r.patch(
    '/:projectId/members/:userId',
    validate({ params: s.projectMemberParams, body: s.updateProjectMemberBody }),
    c.updateMember,
  );
  r.delete('/:projectId/members/:userId', validate({ params: s.projectMemberParams }), c.removeMember);

  // Nested collection: tasks of a project
  r.get('/:projectId/tasks', validate({ params: s.projectIdParams, query: ts.listTasksQuery }), tasks.list);
  r.post('/:projectId/tasks', validate({ params: s.projectIdParams, body: ts.createTaskBody }), tasks.create);

  return r;
};
