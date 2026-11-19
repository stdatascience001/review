import type { NextFunction, Request, RequestHandler, Response } from 'express';
import type { UserRole } from '@prisma/client';
import { env } from '../config/env';
import { ACCESS_COOKIE } from '../lib/cookies';
import { forbidden, unauthorized } from '../lib/errors';
import { verifyAccessToken } from '../lib/jwt';
import { prisma } from '../lib/prisma';

/** Reads the access token from the HTTP-only cookie, or an `Authorization: Bearer` header. */
export const extractAccessToken = (req: Request): string | undefined => {
  const header = req.get('authorization');
  if (header?.startsWith('Bearer ')) return header.slice(7).trim();
  const cookie = req.cookies?.[ACCESS_COOKIE];
  return typeof cookie === 'string' && cookie ? cookie : undefined;
};

/**
 * Verifies the access JWT *and* the server-side session, so logout, "log out everywhere",
 * password resets and account suspension take effect immediately rather than when the JWT expires.
 */
/**
 * Verifies an access JWT *and* its server-side session, so logout, "log out everywhere",
 * password resets and suspension take effect immediately. Shared by HTTP requests and the
 * real-time socket handshake.
 */
export const authContextFromToken = async (token: string | undefined): Promise<Express.AuthContext> => {
  if (!token) throw unauthorized();
  const payload = verifyAccessToken(token);
  if (!payload) throw unauthorized('Access token is invalid or expired', 'TOKEN_INVALID');

  const session = await prisma.userSession.findUnique({
    where: { id: payload.sid },
    select: {
      userId: true,
      revokedAt: true,
      expiresAt: true,
      websiteId: true,
      user: { select: { id: true, email: true, role: true, status: true, emailVerifiedAt: true } },
    },
  });

  if (
    !session ||
    session.userId !== payload.sub ||
    session.revokedAt ||
    session.expiresAt <= new Date() ||
    session.websiteId // widget sessions never authenticate dashboard requests
  ) {
    throw unauthorized('Session has ended, please sign in again', 'SESSION_EXPIRED');
  }
  if (session.user.status !== 'ACTIVE') throw forbidden('Account is suspended', 'ACCOUNT_SUSPENDED');

  return {
    userId: session.user.id,
    sessionId: payload.sid,
    // Use the role from the DB, not the token, so role changes apply immediately.
    role: session.user.role,
    email: session.user.email,
    emailVerified: Boolean(session.user.emailVerifiedAt),
  };
};

export const authenticate: RequestHandler = async (req: Request, _res: Response, next: NextFunction) => {
  req.auth = await authContextFromToken(extractAccessToken(req));
  next();
};

/** Global (platform-level) role check, e.g. SUPER_ADMIN-only endpoints. */
export const requireRole =
  (...roles: UserRole[]): RequestHandler =>
  (req, _res, next) => {
    if (!req.auth) throw unauthorized();
    if (!roles.includes(req.auth.role)) throw forbidden();
    next();
  };

/** Workspace APIs require a verified email (configurable via REQUIRE_EMAIL_VERIFICATION). */
export const requireVerifiedEmail: RequestHandler = (req, _res, next) => {
  if (!req.auth) throw unauthorized();
  if (env.REQUIRE_EMAIL_VERIFICATION && !req.auth.emailVerified) {
    throw forbidden('Please verify your email address first', 'EMAIL_NOT_VERIFIED');
  }
  next();
};

/** Helper for controllers behind `authenticate`. */
export const authOf = (req: Request): Express.AuthContext => {
  if (!req.auth) throw unauthorized();
  return req.auth;
};
