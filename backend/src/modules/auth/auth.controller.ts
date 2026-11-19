import type { Request, Response } from 'express';
import { env } from '../../config/env';
import {
  OAUTH_STATE_COOKIE,
  REFRESH_COOKIE,
  clearAuthCookies,
  clearOAuthStateCookie,
  setAuthCookies,
  setOAuthStateCookie,
} from '../../lib/cookies';
import { safeEqual } from '../../lib/crypto';
import { notFound, unauthorized } from '../../lib/errors';
import { clientMeta, safeRedirectPath } from '../../lib/http';
import { verifyAccessToken } from '../../lib/jwt';
import { logger } from '../../lib/logger';
import { authOf, extractAccessToken } from '../../middleware/authenticate';
import { bodyOf, paramsOf, queryOf } from '../../middleware/validate';
import * as schemas from './auth.schemas';
import * as auth from './auth.service';
import * as google from './google.service';
import * as sessions from './session.service';
import { renderWidgetAuthResult } from '../widget/widget.popup';

const respondWithSession = (res: Response, status: number, result: auth.AuthResult) => {
  setAuthCookies(res, result.session.accessToken, result.session.refreshToken, result.session.expiresAt);
  res.status(status).json({ data: { user: result.user, sessionExpiresAt: result.session.expiresAt } });
};

export const register = async (req: Request, res: Response) => {
  const result = await auth.register(bodyOf(req, schemas.registerBody), clientMeta(req));
  respondWithSession(res, 201, result);
};

export const login = async (req: Request, res: Response) => {
  const result = await auth.login(bodyOf(req, schemas.loginBody), clientMeta(req));
  respondWithSession(res, 200, result);
};

export const refresh = async (req: Request, res: Response) => {
  const token = req.cookies?.[REFRESH_COOKIE];
  if (typeof token !== 'string' || !token) throw unauthorized('No session', 'SESSION_EXPIRED');
  try {
    const session = await sessions.refreshSession(token, clientMeta(req));
    setAuthCookies(res, session.accessToken, session.refreshToken, session.expiresAt);
    res.json({ data: { sessionExpiresAt: session.expiresAt } });
  } catch (err) {
    clearAuthCookies(res);
    throw err;
  }
};

/** Works even with an expired access token (falls back to the refresh cookie). Always succeeds. */
export const logout = async (req: Request, res: Response) => {
  let sessionId: string | null = null;
  const access = extractAccessToken(req);
  if (access) sessionId = verifyAccessToken(access)?.sid ?? null;
  const refreshToken = req.cookies?.[REFRESH_COOKIE];
  if (!sessionId && typeof refreshToken === 'string' && refreshToken) {
    sessionId = await sessions.findSessionIdByRefreshToken(refreshToken);
  }
  if (sessionId) await sessions.revokeSession(sessionId);
  clearAuthCookies(res);
  res.status(204).end();
};

export const logoutAll = async (req: Request, res: Response) => {
  await sessions.revokeAllSessions(authOf(req).userId);
  clearAuthCookies(res);
  res.status(204).end();
};

export const listSessions = async (req: Request, res: Response) => {
  const { userId, sessionId } = authOf(req);
  const list = await sessions.listActiveSessions(userId);
  res.json({ data: list.map((s) => ({ ...s, current: s.id === sessionId })) });
};

export const revokeSession = async (req: Request, res: Response) => {
  const { userId, sessionId: current } = authOf(req);
  const { sessionId } = paramsOf(req, schemas.sessionIdParams);
  if (!(await sessions.revokeOwnSession(userId, sessionId))) throw notFound('Session not found');
  if (sessionId === current) clearAuthCookies(res);
  res.status(204).end();
};

export const verifyEmail = async (req: Request, res: Response) => {
  const user = await auth.verifyEmail(bodyOf(req, schemas.verifyEmailBody).token);
  res.json({ data: { user } });
};

export const resendVerification = async (req: Request, res: Response) => {
  await auth.resendVerification(authOf(req).userId);
  res.json({ data: { message: 'Verification email sent' } });
};

export const forgotPassword = async (req: Request, res: Response) => {
  await auth.forgotPassword(bodyOf(req, schemas.forgotPasswordBody).email);
  res.json({ data: { message: 'If an account exists for that email, a password reset link has been sent' } });
};

export const resetPassword = async (req: Request, res: Response) => {
  const { token, password } = bodyOf(req, schemas.resetPasswordBody);
  await auth.resetPassword(token, password);
  clearAuthCookies(res);
  res.json({ data: { message: 'Password has been reset. Please sign in with your new password.' } });
};

// ───────────────────────────── Google ─────────────────────────────

export const googleStart = async (req: Request, res: Response) => {
  const { redirect } = queryOf(req, schemas.googleStartQuery);
  const { url, cookieValue } = google.buildGoogleAuthUrl(safeRedirectPath(redirect));
  setOAuthStateCookie(res, cookieValue);
  res.redirect(302, url);
};

export const googleCallback = async (req: Request, res: Response) => {
  const { code, state, error } = queryOf(req, schemas.googleCallbackQuery);
  const stored = google.parseStateCookie(req.cookies?.[OAUTH_STATE_COOKIE]);
  clearOAuthStateCookie(res);

  const fail = (reason: string) => {
    const url = new URL('/login', env.APP_URL);
    url.searchParams.set('error', reason);
    res.redirect(302, url.toString());
  };

  // Started from the review widget: answer the popup instead of redirecting to the dashboard.
  if (stored?.widget) {
    const target = stored.widget;
    if (error) return renderWidgetAuthResult(res, target.origin, { ok: false, error: 'google_denied' });
    if (!code || !state || !safeEqual(state, stored.state)) {
      return renderWidgetAuthResult(res, target.origin, { ok: false, error: 'invalid_state' });
    }
    try {
      const profile = await google.exchangeCodeForProfile(code, stored.codeVerifier);
      const result = await auth.loginWithGoogleProfile(profile, clientMeta(req), { widgetWebsiteId: target.websiteId });
      return renderWidgetAuthResult(res, target.origin, {
        ok: true,
        user: result.user,
        session: {
          accessToken: result.session.accessToken,
          refreshToken: result.session.refreshToken,
          expiresAt: result.session.expiresAt,
        },
      });
    } catch (err) {
      logger.warn({ err }, 'widget google oauth callback failed');
      const c = (err as { code?: string }).code;
      return renderWidgetAuthResult(res, target.origin, { ok: false, error: c === 'ACCOUNT_SUSPENDED' ? 'account_suspended' : 'google_failed' });
    }
  }

  if (error) return fail('google_denied');
  if (!code || !state || !stored || !safeEqual(state, stored.state)) return fail('invalid_state');

  try {
    const profile = await google.exchangeCodeForProfile(code, stored.codeVerifier);
    const result = await auth.loginWithGoogleProfile(profile, clientMeta(req));
    setAuthCookies(res, result.session.accessToken, result.session.refreshToken, result.session.expiresAt);
    res.redirect(302, new URL(safeRedirectPath(stored.redirect), env.APP_URL).toString());
  } catch (err) {
    logger.warn({ err }, 'google oauth callback failed');
    const code = (err as { code?: string }).code;
    fail(code === 'ACCOUNT_SUSPENDED' ? 'account_suspended' : 'google_failed');
  }
};

export const googleToken = async (req: Request, res: Response) => {
  const profile = await google.verifyGoogleIdToken(bodyOf(req, schemas.googleTokenBody).credential);
  respondWithSession(res, 200, await auth.loginWithGoogleProfile(profile, clientMeta(req)));
};
