import { Router } from 'express';
import { audit } from '../../lib/audit';
import { authenticate, requireVerifiedEmail } from '../../middleware/authenticate';
import { validate } from '../../middleware/validate';
import * as projects from '../projects/projects.controller';
import * as ps from '../projects/projects.schemas';
import * as team from '../team/team.controller';
import * as c from './websites.controller';
import * as s from './websites.schemas';

export const websitesRoutes = () => {
  const r = Router();
  r.use(authenticate, requireVerifiedEmail);

  r.get('/', validate({ query: s.listWebsitesQuery }), c.list);
  r.post('/', validate({ body: s.createWebsiteBody }), audit('website.created', { meta: (_req, body) => ({ id: (body as { data?: { id?: string } })?.data?.id }) }), c.create);
  r.get('/:websiteId', validate({ params: s.websiteIdParams }), c.get);
  r.patch('/:websiteId', validate({ params: s.websiteIdParams, body: s.updateWebsiteBody }), audit('website.updated', { website: 'websiteId', meta: (req) => ({ changes: req.body }) }), c.update);
  r.delete('/:websiteId', validate({ params: s.websiteIdParams }), audit('website.deleted', { website: 'websiteId' }), c.remove);
  r.post('/:websiteId/regenerate-site-id', validate({ params: s.websiteIdParams }), audit('website.site_id_regenerated', { website: 'websiteId' }), c.regenerateSiteId);
  r.post('/:websiteId/verify-domain', validate({ params: s.websiteIdParams }), audit('website.domain_verification', { website: 'websiteId', meta: (_req, body) => ({ verified: (body as { data?: { verified?: boolean } })?.data?.verified }) }), c.verifyDomain);

  r.get('/:websiteId/settings', validate({ params: s.websiteIdParams }), c.getSettings);
  r.patch('/:websiteId/settings', validate({ params: s.websiteIdParams, body: s.updateSettingsBody }), audit('website.settings_updated', { website: 'websiteId', meta: (req) => ({ changes: req.body }) }), c.updateSettings);

  // Team
  r.get('/:websiteId/members', validate({ params: s.websiteIdParams }), team.listMembers);
  r.post('/:websiteId/members', validate({ params: s.websiteIdParams, body: s.addMemberBody }), audit('member.added', { website: 'websiteId', meta: (req) => ({ email: req.body.email, role: req.body.role }) }), team.addMember);
  r.patch('/:websiteId/members/:userId', validate({ params: s.memberParams, body: s.updateMemberBody }), audit('member.role_changed', { website: 'websiteId', target: { type: 'user', param: 'userId' }, meta: (req) => ({ role: req.body.role }) }), team.updateMember);
  r.put(
    '/:websiteId/members/:userId/projects',
    validate({ params: s.memberParams, body: s.setMemberProjectsBody }),
    team.setMemberProjects,
  );
  r.delete('/:websiteId/members/:userId', validate({ params: s.memberParams }), audit('member.removed', { website: 'websiteId', target: { type: 'user', param: 'userId' } }), team.removeMember);
  r.get('/:websiteId/invitations', validate({ params: s.websiteIdParams }), team.listInvitations);
  r.post('/:websiteId/invitations', validate({ params: s.websiteIdParams, body: s.inviteBody }), audit('invitation.created', { website: 'websiteId', meta: (req) => ({ email: req.body.email, role: req.body.role }) }), team.invite);
  r.post('/:websiteId/invitations/:invitationId/resend', validate({ params: s.invitationParams }), team.resendInvitation);
  r.delete('/:websiteId/invitations/:invitationId', validate({ params: s.invitationParams }), audit('invitation.revoked', { website: 'websiteId', target: { type: 'invitation', param: 'invitationId' } }), team.revokeInvitation);
  r.get('/:websiteId/performance', validate({ params: s.websiteIdParams }), team.performance);

  // Nested collection: projects of a website
  r.get('/:websiteId/projects', validate({ params: s.websiteIdParams, query: ps.listProjectsQuery }), projects.listForWebsite);
  r.post('/:websiteId/projects', validate({ params: s.websiteIdParams, body: ps.createProjectBody }), projects.createForWebsite);

  return r;
};
