import rateLimit, { type Options } from 'express-rate-limit';
import { env } from '../config/env';

const handler: Options['handler'] = (_req, res, _next, options) => {
  res.status(options.statusCode).json({
    error: { code: 'RATE_LIMITED', message: 'Too many requests, please try again later' },
  });
};

/** General API limiter (per IP). */
export const createApiLimiter = (max = env.RATE_LIMIT_MAX) =>
  rateLimit({
    windowMs: env.RATE_LIMIT_WINDOW_MINUTES * 60 * 1000,
    limit: max,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    handler,
  });

/**
 * Strict limiter for credential and token endpoints (login, register, reset…), per IP.
 * Only failed attempts count (wrong password, bad token…): brute force is stopped, while
 * people who sign in successfully — several tabs, widgets on several sites — never are.
 */
export const createAuthLimiter = (max = env.AUTH_RATE_LIMIT_MAX) =>
  rateLimit({
    windowMs: env.RATE_LIMIT_WINDOW_MINUTES * 60 * 1000,
    limit: max,
    skipSuccessfulRequests: true,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    handler,
  });
