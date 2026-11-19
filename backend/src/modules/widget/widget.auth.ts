import { forbidden, unauthorized } from '../../lib/errors';
import { verifyWidgetToken } from '../../lib/jwt';
import { prisma } from '../../lib/prisma';
import { siteByIdForOrigin, type WidgetSite } from './widget.service';

/**
 * Verifies a widget access token: signature + audience, the site-bound session (not revoked,
 * not expired, same website), the user's status, and that `origin` is allowed for the website.
 * Shared by the widget HTTP API and the widget's real-time socket.
 */
export const widgetAuthFromToken = async (
  token: string | undefined,
  origin: string | undefined,
): Promise<{ auth: Express.AuthContext; site: WidgetSite }> => {
  const payload = token ? verifyWidgetToken(token) : null;
  if (!payload) throw unauthorized('Please sign in again', 'TOKEN_INVALID');

  const session = await prisma.userSession.findUnique({
    where: { id: payload.sid },
    select: {
      userId: true,
      websiteId: true,
      revokedAt: true,
      expiresAt: true,
      user: { select: { id: true, email: true, role: true, status: true, emailVerifiedAt: true } },
    },
  });
  if (
    !session ||
    session.userId !== payload.sub ||
    session.websiteId !== payload.wid ||
    session.revokedAt ||
    session.expiresAt <= new Date()
  ) {
    throw unauthorized('Session has ended, please sign in again', 'SESSION_EXPIRED');
  }
  if (session.user.status !== 'ACTIVE') throw forbidden('Account is suspended', 'ACCOUNT_SUSPENDED');

  const site = await siteByIdForOrigin(payload.wid, origin);
  return {
    site,
    auth: {
      userId: session.user.id,
      sessionId: payload.sid,
      role: session.user.role,
      email: session.user.email,
      emailVerified: Boolean(session.user.emailVerifiedAt),
    },
  };
};
