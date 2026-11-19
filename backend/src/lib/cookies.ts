import type { CookieOptions, Response } from 'express';
import { env } from '../config/env';

export const ACCESS_COOKIE = 'wrtm_at';
export const REFRESH_COOKIE = 'wrtm_rt';
export const OAUTH_STATE_COOKIE = 'wrtm_oauth';

// The refresh token cookie is only ever sent to the auth endpoints.
const AUTH_PATH = '/api/v1/auth';
const GOOGLE_PATH = `${AUTH_PATH}/google`;

const base = (): CookieOptions => ({
  httpOnly: true,
  secure: env.COOKIE_SECURE,
  sameSite: 'lax',
  domain: env.COOKIE_DOMAIN,
});

export const setAuthCookies = (res: Response, accessToken: string, refreshToken: string, sessionExpiresAt: Date) => {
  res.cookie(ACCESS_COOKIE, accessToken, {
    ...base(),
    path: '/',
    maxAge: env.ACCESS_TOKEN_TTL_MINUTES * 60 * 1000,
  });
  res.cookie(REFRESH_COOKIE, refreshToken, {
    ...base(),
    path: AUTH_PATH,
    expires: sessionExpiresAt,
  });
};

export const clearAuthCookies = (res: Response) => {
  res.clearCookie(ACCESS_COOKIE, { ...base(), path: '/' });
  res.clearCookie(REFRESH_COOKIE, { ...base(), path: AUTH_PATH });
};

export const setOAuthStateCookie = (res: Response, value: string) =>
  res.cookie(OAUTH_STATE_COOKIE, value, { ...base(), path: GOOGLE_PATH, maxAge: 10 * 60 * 1000 });

export const clearOAuthStateCookie = (res: Response) =>
  res.clearCookie(OAUTH_STATE_COOKIE, { ...base(), path: GOOGLE_PATH });
