import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { authenticate, authOf, requireVerifiedEmail } from '../../middleware/authenticate';
import { queryOf, validate } from '../../middleware/validate';
import { getStats, listWebsites, websiteUsers } from './dashboard.service';

const websiteParams = z.object({ websiteId: z.string().uuid() });
export const dashboardQuery = z.object({ websiteId: z.string().uuid().optional() });

const stats = async (req: Request, res: Response) => {
  res.json({ data: await getStats(authOf(req).userId, queryOf(req, dashboardQuery).websiteId) });
};

export const dashboardRoutes = () => {
  const r = Router();
  r.use(authenticate, requireVerifiedEmail);
  r.get('/', validate({ query: dashboardQuery }), stats);
  r.get('/websites', async (req, res) => {
    res.json({ data: await listWebsites(authOf(req).userId) });
  });
  r.get('/websites/:websiteId/users', validate({ params: websiteParams }), async (req, res) => {
    res.json({ data: await websiteUsers(authOf(req).userId, String(req.params.websiteId)) });
  });
  return r;
};
