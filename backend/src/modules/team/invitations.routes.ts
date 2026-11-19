import { Router, type RequestHandler } from 'express';
import { audit } from '../../lib/audit';
import { authenticate } from '../../middleware/authenticate';
import { validate } from '../../middleware/validate';
import * as c from './team.controller';

/**
 * Invitation endpoints used by the invitee.
 * Accepting does not require a verified email: the emailed link itself proves mailbox ownership.
 */
export const invitationsRoutes = (authLimiter: RequestHandler) => {
  const r = Router();
  r.get('/:token', authLimiter, validate({ params: c.tokenParams }), c.previewInvitation);
  r.post('/accept', authLimiter, authenticate, validate({ body: c.tokenBody }), audit('invitation.accepted'), c.acceptInvitation);
  return r;
};
