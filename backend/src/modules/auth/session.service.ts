import type { User } from '@prisma/client';
import { env } from '../../config/env';
import { prisma } from '../../lib/prisma';
import { generateToken, sha256 } from '../../lib/crypto';
import { signAccessToken, signWidgetToken } from '../../lib/jwt';
import type { ClientMeta } from '../../lib/http';
import { unauthorized } from '../../lib/errors';
import { disconnectSession } from '../../lib/realtime';

export interface IssuedSession {
  sessionId: string;
  accessToken: string;
  refreshToken: string;
  expiresAt: Date;
}

const sessionExpiry = () => new Date(Date.now() + env.SESSION_TTL_DAYS * 24 * 60 * 60 * 1000);

/** Creates a server-side session (refresh token stored hashed) and a short-lived access JWT. */
export type AuthMethod = 'password' | 'google' | 'widget-password' | 'widget-google';

/**
 * A session with `websiteId` set is a review-widget session: its access tokens use the
 * widget audience and only work on that website's widget API.
 */
export const createSession = async (
  user: Pick<User, 'id' | 'role'>,
  meta: ClientMeta,
  authMethod: AuthMethod,
  websiteId?: string,
): Promise<IssuedSession> => {
  const refreshToken = generateToken(48);
  const expiresAt = sessionExpiry();
  const session = await prisma.userSession.create({
    data: {
      userId: user.id,
      refreshTokenHash: sha256(refreshToken),
      userAgent: meta.userAgent,
      ipAddress: meta.ipAddress,
      authMethod,
      expiresAt,
      websiteId: websiteId ?? null,
    },
  });
  return {
    sessionId: session.id,
    accessToken: websiteId
      ? signWidgetToken({ sub: user.id, sid: session.id, wid: websiteId })
      : signAccessToken({ sub: user.id, sid: session.id, role: user.role }),
    refreshToken,
    expiresAt,
  };
};

/**
 * Exchanges a refresh token for a new access token, rotating the refresh token
 * (the old one stops working immediately).
 */
export const refreshSession = async (
  refreshToken: string,
  meta: ClientMeta,
  /** null = dashboard session; a website id = widget session for that website. */
  websiteId: string | null = null,
): Promise<IssuedSession> => {
  const session = await prisma.userSession.findUnique({
    where: { refreshTokenHash: sha256(refreshToken) },
    include: { user: { select: { id: true, role: true, status: true } } },
  });
  // A widget refresh token can never be exchanged for a dashboard session (or vice versa).
  if (!session || session.revokedAt || session.expiresAt <= new Date() || session.websiteId !== websiteId) {
    throw unauthorized('Session expired, please sign in again', 'SESSION_EXPIRED');
  }
  if (session.user.status !== 'ACTIVE') {
    await revokeSession(session.id);
    throw unauthorized('Account is not active', 'ACCOUNT_INACTIVE');
  }

  const newRefreshToken = generateToken(48);
  // Conditional update guards against two concurrent refreshes both rotating the same token.
  const rotated = await prisma.userSession.updateMany({
    where: { id: session.id, refreshTokenHash: session.refreshTokenHash, revokedAt: null },
    data: {
      refreshTokenHash: sha256(newRefreshToken),
      lastUsedAt: new Date(),
      ipAddress: meta.ipAddress,
      userAgent: meta.userAgent,
    },
  });
  if (rotated.count !== 1) throw unauthorized('Session expired, please sign in again', 'SESSION_EXPIRED');

  return {
    sessionId: session.id,
    accessToken: websiteId
      ? signWidgetToken({ sub: session.user.id, sid: session.id, wid: websiteId })
      : signAccessToken({ sub: session.user.id, sid: session.id, role: session.user.role }),
    refreshToken: newRefreshToken,
    expiresAt: session.expiresAt,
  };
};

export const findSessionIdByRefreshToken = async (refreshToken: string): Promise<string | null> => {
  const s = await prisma.userSession.findUnique({
    where: { refreshTokenHash: sha256(refreshToken) },
    select: { id: true },
  });
  return s?.id ?? null;
};

export const revokeSession = async (sessionId: string) => {
  const r = await prisma.userSession.updateMany({ where: { id: sessionId, revokedAt: null }, data: { revokedAt: new Date() } });
  disconnectSession(sessionId); // live (Socket.IO) connections end with the session
  return r;
};

export const revokeAllSessions = async (userId: string, exceptSessionId?: string) => {
  const where = { userId, revokedAt: null, ...(exceptSessionId ? { id: { not: exceptSessionId } } : {}) };
  const ids = (await prisma.userSession.findMany({ where, select: { id: true } })).map((s) => s.id);
  const r = await prisma.userSession.updateMany({ where: { id: { in: ids } }, data: { revokedAt: new Date() } });
  ids.forEach(disconnectSession);
  return r;
};

export const listActiveSessions = (userId: string) =>
  prisma.userSession.findMany({
    where: { userId, revokedAt: null, expiresAt: { gt: new Date() } },
    select: {
      id: true,
      userAgent: true,
      ipAddress: true,
      authMethod: true,
      createdAt: true,
      lastUsedAt: true,
      expiresAt: true,
    },
    orderBy: { lastUsedAt: 'desc' },
  });

/** Revokes one of the user's own sessions. Returns false if it doesn't exist or isn't theirs. */
export const revokeOwnSession = async (userId: string, sessionId: string): Promise<boolean> => {
  const result = await prisma.userSession.updateMany({
    where: { id: sessionId, userId, revokedAt: null },
    data: { revokedAt: new Date() },
  });
  if (result.count === 1) disconnectSession(sessionId);
  return result.count === 1;
};
