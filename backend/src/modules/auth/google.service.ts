import { OAuth2Client } from 'google-auth-library';
import { env } from '../../config/env';
import { generateToken, pkceChallenge } from '../../lib/crypto';
import { serviceUnavailable, unauthorized } from '../../lib/errors';
import type { GoogleProfile } from './auth.service';

/**
 * Google OAuth 2.0 / OpenID Connect.
 *  - Redirect flow: GET /auth/google → Google consent → GET /auth/google/callback
 *    (authorization code + PKCE + state stored in a short-lived HTTP-only cookie)
 *  - Token flow: POST /auth/google/token with an ID token from Google Identity Services.
 * In both cases the ID token signature, audience, issuer and expiry are verified by
 * google-auth-library against Google's public keys.
 */

let client: OAuth2Client | undefined;
const getClient = () => {
  if (!env.googleEnabled) throw serviceUnavailable('Google sign-in is not configured', 'GOOGLE_NOT_CONFIGURED');
  client ??= new OAuth2Client({
    clientId: env.GOOGLE_CLIENT_ID,
    clientSecret: env.GOOGLE_CLIENT_SECRET,
    redirectUri: env.googleRedirectUri,
  });
  return client;
};

/** Set when sign-in was started from the review widget (popup) instead of the dashboard. */
export interface WidgetOAuthTarget {
  websiteId: string;
  /** Origin of the page hosting the widget; the result is postMessage'd only to it. */
  origin: string;
}

export interface OAuthState {
  state: string;
  codeVerifier: string;
  redirect: string;
  widget?: WidgetOAuthTarget;
}

export const buildGoogleAuthUrl = (redirect: string, widget?: WidgetOAuthTarget): { url: string; cookieValue: string } => {
  const oauth = getClient();
  const stateData: OAuthState = { state: generateToken(24), codeVerifier: generateToken(48), redirect, widget };
  const url = oauth.generateAuthUrl({
    access_type: 'online',
    scope: ['openid', 'email', 'profile'],
    state: stateData.state,
    prompt: 'select_account',
    include_granted_scopes: true,
    code_challenge: pkceChallenge(stateData.codeVerifier),
    // google-auth-library types expect its CodeChallengeMethod enum; the value is 'S256'.
    code_challenge_method: 'S256' as never,
  });
  return { url, cookieValue: Buffer.from(JSON.stringify(stateData)).toString('base64url') };
};

export const parseStateCookie = (value: unknown): OAuthState | null => {
  if (typeof value !== 'string' || !value) return null;
  try {
    const parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
    if (typeof parsed?.state === 'string' && typeof parsed?.codeVerifier === 'string') {
      const w = parsed.widget;
      const widget =
        w && typeof w.websiteId === 'string' && typeof w.origin === 'string'
          ? { websiteId: w.websiteId, origin: w.origin }
          : undefined;
      return { state: parsed.state, codeVerifier: parsed.codeVerifier, redirect: String(parsed.redirect ?? '/'), widget };
    }
    return null;
  } catch {
    return null;
  }
};

export const verifyGoogleIdToken = async (idToken: string): Promise<GoogleProfile> => {
  const oauth = getClient();
  try {
    const ticket = await oauth.verifyIdToken({ idToken, audience: env.GOOGLE_CLIENT_ID });
    const p = ticket.getPayload();
    if (!p?.sub || !p.email) throw new Error('missing claims');
    return {
      sub: p.sub,
      email: p.email,
      emailVerified: p.email_verified === true,
      name: p.name,
      picture: p.picture,
    };
  } catch {
    throw unauthorized('Google sign-in could not be verified', 'GOOGLE_TOKEN_INVALID');
  }
};

export const exchangeCodeForProfile = async (code: string, codeVerifier: string): Promise<GoogleProfile> => {
  const oauth = getClient();
  let idToken: string | null | undefined;
  try {
    const { tokens } = await oauth.getToken({ code, codeVerifier, redirect_uri: env.googleRedirectUri });
    idToken = tokens.id_token;
  } catch {
    throw unauthorized('Google sign-in failed', 'GOOGLE_EXCHANGE_FAILED');
  }
  if (!idToken) throw unauthorized('Google sign-in failed', 'GOOGLE_EXCHANGE_FAILED');
  return verifyGoogleIdToken(idToken);
};
