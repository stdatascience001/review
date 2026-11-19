import type { RequestHandler } from 'express';
import { env } from '../config/env';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * CSRF defence-in-depth for cookie-authenticated requests. Auth cookies are SameSite=Lax;
 * in addition, any state-changing request that carries an Origin header must come from
 * an allowed origin. Requests without Origin (server-to-server, curl, mobile) pass through
 * and still need valid credentials.
 */
export const originCheck: RequestHandler = (req, res, next) => {
  if (SAFE_METHODS.has(req.method)) return next();
  const origin = req.get('origin');
  if (!origin) return next();
  const allowed = [...env.corsOrigins, new URL(env.API_URL).origin];
  if (allowed.includes(origin.replace(/\/$/, ''))) return next();
  res.status(403).json({ error: { code: 'INVALID_ORIGIN', message: 'Request origin not allowed' } });
};
