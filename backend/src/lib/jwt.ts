import jwt from 'jsonwebtoken';
import type { UserRole } from '@prisma/client';
import { env } from '../config/env';

const ISSUER = 'wrtm-api';
const AUDIENCE = 'wrtm-app';

export interface AccessTokenPayload {
  sub: string; // user id
  sid: string; // session id
  role: UserRole;
}

export const signAccessToken = (payload: AccessTokenPayload): string =>
  jwt.sign(payload, env.JWT_ACCESS_SECRET, {
    algorithm: 'HS256',
    expiresIn: env.ACCESS_TOKEN_TTL_MINUTES * 60,
    issuer: ISSUER,
    audience: AUDIENCE,
  });

/** Returns the payload, or null if the token is invalid or expired. */
export const verifyAccessToken = (token: string): (AccessTokenPayload & { iat: number; exp: number }) | null => {
  try {
    const decoded = jwt.verify(token, env.JWT_ACCESS_SECRET, {
      algorithms: ['HS256'],
      issuer: ISSUER,
      audience: AUDIENCE,
    });
    if (typeof decoded !== 'object' || typeof decoded.sub !== 'string' || typeof decoded.sid !== 'string') {
      return null;
    }
    return decoded as AccessTokenPayload & { iat: number; exp: number };
  } catch {
    return null;
  }
};

// ───────────────────────────── Review widget tokens ─────────────────────────────
// Separate audience: a widget token is bound to one website and is rejected by the
// main API (verifyAccessToken checks aud=wrtm-app), so a token stolen from a customer's
// site cannot be used against the admin dashboard API.
const WIDGET_AUDIENCE = 'wrtm-widget';

export interface WidgetTokenPayload {
  sub: string; // user id
  sid: string; // session id
  wid: string; // website id
}

export const signWidgetToken = (payload: WidgetTokenPayload): string =>
  jwt.sign(payload, env.JWT_ACCESS_SECRET, {
    algorithm: 'HS256',
    expiresIn: env.ACCESS_TOKEN_TTL_MINUTES * 60,
    issuer: ISSUER,
    audience: WIDGET_AUDIENCE,
  });

export const verifyWidgetToken = (token: string): (WidgetTokenPayload & { exp: number }) | null => {
  try {
    const d = jwt.verify(token, env.JWT_ACCESS_SECRET, { algorithms: ['HS256'], issuer: ISSUER, audience: WIDGET_AUDIENCE });
    if (typeof d !== 'object' || typeof d.sub !== 'string' || typeof d.sid !== 'string' || typeof d.wid !== 'string') {
      return null;
    }
    return d as WidgetTokenPayload & { exp: number };
  } catch {
    return null;
  }
};
